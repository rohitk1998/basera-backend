import {
  BadRequestException,
  ConflictException,
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { UserEntity, EmailOtpEntity } from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { UserService } from '../user/user.service';
import { CompleteSignupDto } from './dto/complete-signup.dto';

export type AvatarUploadFile = { buffer: Buffer; mimetype: string; size: number };

const WEEK_SECONDS = 60 * 60 * 24 * 7;
const YEAR_SECONDS = 60 * 60 * 24 * 365;
const REFRESH_TOKEN_SECONDS = YEAR_SECONDS / 12; // 30 days — outlives the 7-day access token so it can renew it
const REFRESH_GRACE_MS = 15_000; // a just-rotated refresh token still answers with the same new tokens for this long

// TTL for the proof-of-identity token minted by session()/verifyEmailOtp()
// for a brand-new signup — see issueProofToken below. Long enough to fill
// out ProfileScreen, short enough that a leaked/abandoned token is useless
// shortly after.
const PROFILE_COMPLETION_TOKEN_MINUTES = 10;

// Distinct `purpose` claim, checked explicitly by completeSignup() and never
// set by issueSession() — this is what makes it impossible for this token to
// be mistaken for (or replayed as) a real session. It also has no `sub`
// claim, which independently makes AuthGuard.verify() reject it (it throws
// 'No user ID in token' when decoded.sub is missing), so even if this token
// were ever presented as a session cookie, AuthGuard would already refuse it
// before the purpose check would even matter.
const PROFILE_COMPLETION_TOKEN_PURPOSE = 'profile-completion';

interface ProfileCompletionClaims extends jwt.JwtPayload {
  purpose: typeof PROFILE_COMPLETION_TOKEN_PURPOSE;
  phone?: string;
  email?: string;
  firebaseUid?: string;
}

// Email OTP tuning — see web/supabase/migrations/20260916_email_otps.sql.
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_RESEND_DEBOUNCE_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

/** Cookie values a freshly-issued session needs — the controller sets the
 *  actual HTTP cookies from this; AuthService never touches `Response`. */
export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
};

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Same sha256 hashing approach as hashRefreshToken above — see
// EmailOtpEntity.code_hash for why this isn't bcrypt.
function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateOtpCode(): string {
  // 6-digit numeric, zero-padded — crypto.randomInt is uniform and
  // cryptographically strong, unlike Math.random().
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
}

// Deterministic Firebase UID -> Supabase-shaped UUID mapping. Ported as-is
// from web/app/api/auth/session/route.ts — changing the derivation would
// orphan every existing profile row from its Firebase account.
function firebaseUidToSupabaseUuid(uid: string): string {
  const md5 = crypto.createHash('md5').update(uid).digest('hex');
  return `${md5.slice(0, 8)}-${md5.slice(8, 12)}-4${md5.slice(13, 16)}-a${md5.slice(17, 20)}-${md5.slice(20, 32)}`;
}

/**
 * Business logic behind AuthController — bcrypt/jwt/OTP handling and every
 * repository access, extracted out of the controller so the controller is
 * left owning only the HTTP concerns (reading the request, setting cookies,
 * shaping the response). Session/proof-token *issuance* still lives here
 * (it's crypto + a DB write, not an HTTP concern); only the actual
 * `res.cookie(...)` calls stay in the controller, since AuthService never
 * touches `Request`/`Response`.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Old refresh-token hash -> the tokens it was rotated into; see rotateSession. */
  private readonly recentRotations = new Map<string, { userId: string; at: number; tokens: Promise<SessionTokens> }>();

  constructor(
    private readonly firebase: FirebaseAdminProvider,
    private readonly config: ConfigService,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    @InjectRepository(EmailOtpEntity)
    private readonly emailOtps: Repository<EmailOtpEntity>,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
  ) {}

  /** Verifies a Firebase ID token and returns the decoded claims. Throws
   *  BadRequestException for a genuine auth/* error (bad/expired token —
   *  the caller's fault) or InternalServerErrorException for anything else
   *  (a Firebase SDK/network failure — ours, not theirs). */
  async verifyFirebaseToken(firebaseToken: string): Promise<{ uid: string; phone_number?: string }> {
    try {
      return await this.firebase.auth.verifyIdToken(firebaseToken);
    } catch (err: any) {
      const isAuthError = typeof err?.code === 'string' && err.code.startsWith('auth/');
      if (isAuthError) {
        throw new BadRequestException(err.code);
      }
      this.logger.warn(`Firebase verifyIdToken failed: ${err?.message ?? err}`);
      throw new InternalServerErrorException('Could not verify sign-in token. Please try again.');
    }
  }

  firebaseUidToUserId(uid: string): string {
    return firebaseUidToSupabaseUuid(uid);
  }

  async findProfileById(id: string): Promise<UserEntity | null> {
    return this.profiles.findOne({ where: { id } });
  }

  async findProfileByEmail(email: string): Promise<UserEntity | null> {
    return this.profiles.findOne({ where: { email } });
  }

  /**
   * Admin-only credential login. Separate from the phone-OTP flow used by
   * every other account: admins are already a manually-provisioned
   * profiles.role = 'admin' flag (see AdminGuard), so this is a second way
   * to authenticate into that same kind of account, not a new signup path
   * — there is no self-serve way to create an admin or set this password;
   * see scripts/seed-admin.mjs.
   */
  async verifyAdminCredentials(email: string, password: string): Promise<UserEntity> {
    const profile = await this.profiles.findOne({ where: { email } });

    // Same "invalid credentials" message whether the email doesn't exist,
    // isn't an admin, or has no password set — never reveal which.
    const invalid = () => new UnauthorizedException('Invalid email or password');

    if (!profile || profile.role !== 'admin' || !profile.password_hash) {
      throw invalid();
    }

    const passwordMatches = await bcrypt.compare(password, profile.password_hash);
    if (!passwordMatches) {
      throw invalid();
    }

    return profile;
  }

  /**
   * Sends a 6-digit code to `email` — the entry point for the email-OTP
   * flow that replaced email+password signup/login. Works uniformly
   * whether this email belongs to an existing account (any signup method)
   * or none yet; verifyEmailOtp is what decides new-signup vs.
   * existing-login, same split session() makes for phone-OTP.
   *
   * Debounced at 60s per email via last_sent_at rather than a rate-limiting
   * package — consistent with this codebase's earlier decision to defer
   * that dependency for the per-email case (see AuthController's
   * IP-scoped @Throttle() on top of this, which covers what the debounce
   * alone doesn't: one attacker cycling through many addresses). One row
   * per email (upsert), so a second send for the same email always
   * overwrites rather than accumulating rows.
   */
  async sendEmailOtp(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();

    const existing = await this.emailOtps.findOne({ where: { email } });
    if (existing) {
      const elapsedSeconds = (Date.now() - existing.last_sent_at.getTime()) / 1000;
      if (elapsedSeconds < OTP_RESEND_DEBOUNCE_SECONDS) {
        throw new HttpException(
          `Please wait ${Math.ceil(OTP_RESEND_DEBOUNCE_SECONDS - elapsedSeconds)}s before requesting another code.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // Decided here, never taken from the client: an address with no completed
    // account is finishing a signup, anyone else is signing in. Only changes
    // the wording of the email.
    const account = await this.profiles.findOne({ where: { email }, select: { id: true, full_name: true } });
    const purpose = account?.full_name ? 'login' : 'signup';

    const code = generateOtpCode();
    const now = new Date();

    // Send BEFORE persisting: if SMTP fails, no row (and no resend-debounce
    // window) should exist for a code the user never actually received —
    // otherwise a transient send failure would lock them out of retrying
    // for OTP_RESEND_DEBOUNCE_SECONDS with nothing to show for it. Via SMTP,
    // not Resend: Resend's shared test sender only delivers to a handful of
    // Resend-owned addresses until a real domain is verified, which makes
    // it useless for a code that has to reach an arbitrary inbox right now
    // — see NotificationsService.sendEmailOtpViaSmtp.
    //
    // Explicitly caught rather than left to bubble as a raw 500: SMTP
    // failures (missing config, Gmail rate-limiting, a transient network
    // error) are a realistic, foreseeable failure mode for this brand-new
    // code path, and the caller needs a clear, actionable message — there's
    // no other way for them to know the code never arrived.
    try {
      await this.notifications.sendEmailOtpViaSmtp(email, {
        code,
        expiresInMinutes: OTP_EXPIRY_MINUTES,
        purpose,
      });
    } catch (err: any) {
      this.logger.error(`[sendEmailOtp] SMTP send failed for ${email}`, err);
      throw new InternalServerErrorException(
        'Could not send the verification code. Please try again in a moment.',
      );
    }

    await this.emailOtps.save(
      this.emailOtps.create({
        email,
        code_hash: hashOtpCode(code),
        expires_at: new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60_000),
        attempt_count: 0,
        last_sent_at: now,
      }),
    );
  }

  /**
   * Verifies the code sent by sendEmailOtp above and, on success, signs the
   * caller in — creating a profile row first if none exists yet for this
   * email, same find-or-create shape as session()'s phone-OTP path and the
   * old signup()'s race-safe insert (23505 unique-violation retry).
   *
   * Single-use: the row is deleted once verify succeeds, so a replayed code
   * can never be reused. Locks out after OTP_MAX_ATTEMPTS wrong guesses,
   * requiring a fresh send.
   */
  async verifyEmailOtp(rawEmail: string, code: string): Promise<{ isNewUser: true; email: string } | { isNewUser: boolean; profile: UserEntity }> {
    const email = rawEmail.trim().toLowerCase();

    const otp = await this.emailOtps.findOne({ where: { email } });
    const invalidCode = () => new UnauthorizedException('Invalid or expired code.');

    if (!otp) {
      throw invalidCode();
    }

    if (otp.expires_at.getTime() < Date.now()) {
      await this.emailOtps.delete({ email });
      throw invalidCode();
    }

    if (otp.attempt_count >= OTP_MAX_ATTEMPTS) {
      await this.emailOtps.delete({ email });
      throw new UnauthorizedException('Too many incorrect attempts. Request a new code.');
    }

    if (hashOtpCode(code) !== otp.code_hash) {
      await this.emailOtps.update({ email }, { attempt_count: otp.attempt_count + 1 });
      throw invalidCode();
    }

    // Consume the code — single use, whether this exchange is a signup or
    // a login below.
    await this.emailOtps.delete({ email });

    const existingProfile = await this.profiles.findOne({ where: { email } });

    if (!existingProfile) {
      // Genuinely new signup: no row exists for this email yet. Same
      // deferred treatment as session()'s phone-OTP path — no row, no
      // session, until ProfileScreen completes.
      return { isNewUser: true, email };
    }

    // Backward compatibility: a row exists but was never completed (old
    // pre-fix code path, or a phone-signup account whose email is only now
    // being verified). Nothing left to defer — issue a session immediately,
    // same as any other existing-user login.
    return { isNewUser: !existingProfile.full_name, profile: existingProfile };
  }

  /**
   * The atomic "actually create the account" step for a brand-new signup —
   * called by ProfileScreen's submit, not by the OTP-verify screens. Only
   * reachable with a valid, unexpired proof-of-identity token from
   * session()/verifyEmailOtp() (see issueProofToken/verifyProofToken below);
   * there is no session cookie yet at this point; the token is what proves
   * "this phone/email was just OTP-verified" without an account existing.
   *
   * Row creation and session issuance happen together, in this one call, so
   * there is no window where a permanent account row exists without a
   * completed profile — the exact gap this whole redesign closes. An
   * existing/returning user never reaches this path: session() and
   * verifyEmailOtp() only mint a proofToken for the genuinely-new-row case,
   * and issue a real session directly for every other case.
   *
   * `avatarFile`: an optional photo picked on ProfileScreen. There was
   * previously no session yet at signup time for it to upload against, so
   * the old flow deferred the upload to a follow-up call made AFTER the
   * account already existed — a failure there (e.g. the 1MB minimum size
   * check) just logged a toast while the account was already live and the
   * user was already on the dashboard, silently missing its photo. Here the
   * file is validated (size/type — no I/O, so this alone catches "File too
   * small"/"too large"/unsupported-type with zero account created) BEFORE
   * any row is touched, then uploaded once the row exists (its storage path
   * needs userId); if that upload itself fails, the just-created row is
   * deleted so the whole signup fails atomically rather than leaving a real
   * account with a missing photo.
   */
  async completeSignup(
    dto: CompleteSignupDto,
    avatarFile?: AvatarUploadFile,
  ): Promise<{ userId: string; phone?: string; firebaseUid?: string; avatar_url: string }> {
    if (avatarFile) {
      this.userService.validateAvatarFile(avatarFile);
    }

    const claims = this.verifyProofToken(dto.proofToken);

    let userId: string;
    let phone: string | undefined;
    let firebaseUid: string | undefined;
    // Only true when THIS call inserted a brand-new row — an avatar-upload
    // failure below must roll that back, but must never delete a
    // pre-existing account it merely updated (a replayed token, or the
    // winner of a concurrent-signup race).
    let didInsert = false;
    // True only for the call that completes the account for the first time —
    // a replayed token or a lost concurrent-signup race must not re-welcome.
    let firstCompletion = false;

    if (claims.firebaseUid) {
      // Phone-OTP signup — id is deterministic from the Firebase uid, same
      // derivation session() uses, so this always lands on the same row a
      // second completion attempt (or a stale duplicate token) would.
      phone = claims.phone;
      firebaseUid = claims.firebaseUid;
      userId = firebaseUidToSupabaseUuid(claims.firebaseUid);

      const alreadyExists = await this.profiles.findOne({ where: { id: userId } });
      // A row left behind without a name was never completed; this call is
      // its first real completion, so it still earns the welcome.
      firstCompletion = !alreadyExists || !alreadyExists.full_name;
      if (alreadyExists) {
        // Token was replayed, or a second tab finished ProfileScreen first.
        // Nothing to insert — fall through and just (re-)issue a session,
        // same effect as a normal login, rather than erroring. Still subject
        // to the same email-uniqueness check as the insert branch below: a
        // stale replay that now names someone else's email must not silently
        // steal it either.
        try {
          await this.profiles.update(userId, {
            full_name: dto.name,
            email: dto.email,
            languages: dto.languages,
            isHost: dto.isHost ?? false,
            avatar_url: dto.avatar_url,
          });
        } catch (err: any) {
          if (err?.code === '23505') {
            throw new ConflictException('An account with this email already exists.');
          }
          throw err;
        }
      } else {
        // `email` is unique-constrained independently of `id` — a brand-new
        // phone signup can still collide if the email entered on
        // ProfileScreen already belongs to a different existing account
        // (e.g. one made via email-OTP, or another phone account that
        // already claimed it). This is a real, user-facing conflict, not a
        // race — surface it clearly instead of letting the raw 23505 bubble
        // up as an opaque 500.
        try {
          await this.profiles.insert({
            id: userId,
            phone,
            full_name: dto.name,
            email: dto.email,
            languages: dto.languages,
            isHost: dto.isHost ?? false,
            avatar_url: dto.avatar_url,
            created_at: new Date(),
          });
          didInsert = true;
        } catch (err: any) {
          if (err?.code === '23505') {
            throw new ConflictException('An account with this email already exists.');
          }
          throw err;
        }
      }
    } else if (claims.email) {
      // Email-OTP signup — no deterministic id scheme (unlike phone), so
      // generate one now. Same 23505 race-safe retry pattern the old
      // verifyEmailOtp() used for its insert, kept here since the insert
      // moved but the race it guards against did not.
      const email = claims.email;
      const id = crypto.randomUUID();
      try {
        await this.profiles.insert({
          id,
          email,
          full_name: dto.name,
          languages: dto.languages,
          isHost: dto.isHost ?? false,
          avatar_url: dto.avatar_url,
          created_at: new Date(),
        });
        userId = id;
        didInsert = true;
        firstCompletion = true;
      } catch (err: any) {
        if (err?.code !== '23505') throw err;
        // Two completions for the same brand-new email raced. The DB
        // unique constraint is the real guard; fall back to the row that
        // won and update it with this submission's fields.
        const winner = await this.profiles.findOne({ where: { email } });
        if (!winner) throw err;
        userId = winner.id;
        await this.profiles.update(userId, {
          full_name: dto.name,
          languages: dto.languages,
          isHost: dto.isHost ?? false,
          avatar_url: dto.avatar_url,
        });
      }
    } else {
      // Should be unreachable — verifyProofToken already requires at least
      // one of phone/firebaseUid or email on every token this app mints.
      throw new UnauthorizedException('Invalid verification token');
    }

    let avatarUrl = dto.avatar_url ?? '';
    if (avatarFile) {
      try {
        avatarUrl = await this.userService.uploadAvatarToStorage(userId, avatarFile);
        await this.profiles.update(userId, { avatar_url: avatarUrl });
      } catch (err) {
        if (didInsert) {
          // This call created the row — it must not survive without the
          // photo the user explicitly picked. Roll it back so the caller
          // never gets a "success" response for a signup that silently
          // lost its avatar. Never applies to the replayed-token/
          // concurrent-race update paths above, which touch a row that
          // already existed before this call and isn't this call's to
          // delete.
          await this.profiles.delete({ id: userId });
        }
        throw err;
      }
    }

    if (firstCompletion) {
      // Fire-and-forget, after everything that can still roll the row back.
      this.notifications.notify('user.welcome', userId, {
        userName: dto.name,
        isHost: dto.isHost ?? false,
        link: dto.isHost ? '/host/start' : '/stays',
      });
    }

    return { userId, phone, firebaseUid, avatar_url: avatarUrl };
  }

  /** Validates a refresh-token cookie against the profile it claims to
   *  belong to (by the still-decodable, possibly-expired access token's
   *  `sub` claim) — the refresh-side half of POST /auth/refresh. Returns
   *  the profile to re-issue a session for. */
  async verifyRefreshToken(userId: string, rawRefreshToken: string): Promise<UserEntity> {
    const profile = await this.profiles.findOne({ where: { id: userId } });
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const notExpired =
      profile?.refresh_token_expires_at && profile.refresh_token_expires_at.getTime() > Date.now();

    if (!profile || profile.refresh_token_hash !== tokenHash || !notExpired) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return profile;
  }

  /** The whole refresh step: validate the refresh token, then rotate it.
   *  Two requests carrying the same cookie (two tabs, a double-fired client)
   *  arrive near-simultaneously; the loser would otherwise find the hash the
   *  winner just rotated away and 401. Within REFRESH_GRACE_MS the same old
   *  token therefore gets the SAME freshly issued tokens back (idempotent).
   *  Past the window a reused token is rejected as before. Per-process memory
   *  only — no schema change; across instances the grace simply doesn't apply. */
  async rotateSession(
    userId: string,
    rawRefreshToken: string,
    firebaseUid?: string,
  ): Promise<SessionTokens> {
    const key = hashRefreshToken(rawRefreshToken);
    const now = Date.now();
    for (const [k, v] of this.recentRotations) {
      if (now - v.at > REFRESH_GRACE_MS) this.recentRotations.delete(k);
    }

    const recent = this.recentRotations.get(key);
    if (recent && recent.userId === userId) return recent.tokens;

    const tokens = (async () => {
      const profile = await this.verifyRefreshToken(userId, rawRefreshToken);
      return this.issueSession({ userId: profile.id, phone: profile.phone ?? undefined, firebaseUid });
    })();
    const entry = { userId, at: now, tokens };
    this.recentRotations.set(key, entry);
    tokens.catch(() => {
      if (this.recentRotations.get(key) === entry) this.recentRotations.delete(key);
    });
    return tokens;
  }

  /** Revoke server-side so a stolen refresh-token cookie can't renew
   *  sessions after logout. */
  async revokeRefreshToken(userId: string): Promise<void> {
    await this.profiles.update(userId, { refresh_token_hash: null, refresh_token_expires_at: null });
  }

  /** Every session this app issues has the same JWT shape and the same
   *  refresh-token DB write, regardless of how the caller authenticated —
   *  returns the raw token values; AuthController turns these into cookies.
   *  `role: 'authenticated'` here is the JWT's own claim (PostgREST-style),
   *  unrelated to profiles.role which is what AdminGuard actually checks. */
  async issueSession(opts: { userId: string; phone?: string; firebaseUid?: string }): Promise<SessionTokens> {
    const deviceId = crypto.randomUUID();

    const accessToken = jwt.sign(
      {
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + WEEK_SECONDS,
        sub: opts.userId,
        phone: opts.phone,
        role: 'authenticated',
        device_id: deviceId,
        ...(opts.firebaseUid ? { firebase_uid: opts.firebaseUid } : {}),
      },
      this.config.get<string>('SUPABASE_JWT_SECRET')!,
    );

    const refreshToken = crypto.randomBytes(32).toString('hex');
    await this.profiles.update(opts.userId, {
      refresh_token_hash: hashRefreshToken(refreshToken),
      refresh_token_expires_at: new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000),
    });

    return { accessToken, refreshToken, deviceId };
  }

  /**
   * Mints the short-lived proof-of-identity token returned by session()/
   * verifyEmailOtp() for a brand-new signup instead of a session — signed
   * with the same SUPABASE_JWT_SECRET/jsonwebtoken issueSession() uses, but
   * deliberately NOT shaped like a session token: no `sub` claim (AuthGuard
   * requires one and would reject this immediately even without the
   * purpose check below) and a `purpose` claim issueSession() never sets,
   * so this token can never be confused with, or accepted as, a real
   * session by AuthGuard or anything gated by it.
   */
  issueProofToken(opts: { phone?: string; email?: string; firebaseUid?: string }): string {
    const claims: ProfileCompletionClaims = {
      purpose: PROFILE_COMPLETION_TOKEN_PURPOSE,
      phone: opts.phone,
      email: opts.email,
      firebaseUid: opts.firebaseUid,
    };
    return jwt.sign(claims, this.config.get<string>('SUPABASE_JWT_SECRET')!, {
      expiresIn: `${PROFILE_COMPLETION_TOKEN_MINUTES}m`,
    });
  }

  /**
   * Verifies a proof-of-identity token passed to completeSignup(). Checked
   * against the same secret issueProofToken() signs with; jwt.verify()
   * already rejects an expired or tampered token (thrown as
   * TokenExpiredError/JsonWebTokenError), and the explicit `purpose` check
   * below rejects any other token this app issues (e.g. a real session
   * token, or a refresh token) even though those would never carry this
   * claim in the first place.
   */
  private verifyProofToken(token: string): ProfileCompletionClaims {
    const invalid = () =>
      new UnauthorizedException('Your verification expired. Please start over.');

    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.config.get<string>('SUPABASE_JWT_SECRET')!) as jwt.JwtPayload;
    } catch {
      throw invalid();
    }

    if (decoded.purpose !== PROFILE_COMPLETION_TOKEN_PURPOSE || (!decoded.phone && !decoded.email)) {
      throw invalid();
    }

    return decoded as ProfileCompletionClaims;
  }
}
