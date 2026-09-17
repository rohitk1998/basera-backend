import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  forwardRef,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request, Response } from 'express';
import * as crypto from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { UserEntity, EmailOtpEntity } from '../entities';
import { AuthGuard, SESSION_COOKIE } from './auth.guard';
import { AdminLoginDto } from './dto/admin-login.dto';
import { SendEmailOtpDto } from './dto/send-email-otp.dto';
import { VerifyEmailOtpDto } from './dto/verify-email-otp.dto';
import { CompleteSignupDto } from './dto/complete-signup.dto';
import { NotificationsService } from '../notifications/notifications.service';

const WEEK_SECONDS = 60 * 60 * 24 * 7;
const YEAR_SECONDS = 60 * 60 * 24 * 365;
const REFRESH_TOKEN_SECONDS = YEAR_SECONDS / 12; // 30 days — outlives the 7-day access token so it can renew it

const REFRESH_COOKIE = 'basera_refresh_token';

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

@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly firebase: FirebaseAdminProvider,
    private readonly config: ConfigService,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    @InjectRepository(EmailOtpEntity)
    private readonly emailOtps: Repository<EmailOtpEntity>,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Hands the caller their own current session token back, for the one
   * client-side use that genuinely needs the raw JWT rather than the
   * userId AuthGuard already extracts: supabase.realtime.setAuth(token),
   * so the browser's Realtime websocket authenticates as this user and
   * RLS-gated postgres_changes events (see conversations/messages) are
   * actually delivered instead of silently dropped. Guarded the same way
   * every other endpoint is — a caller can only ever get back the token
   * for the session they're already authenticated with, never anyone
   * else's, since it's read from their own request cookie.
   */
  @Get('realtime-token')
  @UseGuards(AuthGuard)
  realtimeToken(@Req() req: Request) {
    const raw = req.cookies?.[SESSION_COOKIE];
    let token = raw;
    try {
      token = JSON.parse(raw).access_token;
    } catch {
      // raw was already the bare token
    }
    return { token };
  }

  @Post('session')
  async session(
    @Body('firebaseToken') firebaseToken: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!firebaseToken) {
      throw new BadRequestException('No token provided');
    }

    let decodedToken: { uid: string; phone_number?: string };
    try {
      decodedToken = await this.firebase.auth.verifyIdToken(firebaseToken);
    } catch (err: any) {
      const isAuthError = typeof err?.code === 'string' && err.code.startsWith('auth/');
      throw new BadRequestException(isAuthError ? err.code : 'Internal Server Error');
    }

    const { uid } = decodedToken;
    const phone = decodedToken.phone_number;
    if (!phone) {
      throw new BadRequestException('No phone number found on token');
    }

    const supabaseUuid = firebaseUidToSupabaseUuid(uid);

    const existingProfile = await this.profiles.findOne({ where: { id: supabaseUuid } });

    if (!existingProfile) {
      // Genuinely new signup: no row exists for this Firebase identity yet.
      // Defer row creation and session issuance until ProfileScreen submits
      // name/languages/avatar — see completeSignup() below. Hand back a
      // short-lived proof-of-identity token instead of a session so the
      // frontend can prove "this phone/uid was just OTP-verified" without
      // us having created an account or signed anyone in yet.
      const proofToken = this.issueProofToken({ phone, firebaseUid: uid });
      return { success: true, phone, isNewUser: true, proofToken };
    }

    // Backward compatibility: a row that exists but was never completed
    // (e.g. created under the old pre-fix code, which issued a session
    // immediately and only got as far as {id, phone} before the app was
    // closed). Deferring further here would mean deleting/recreating an
    // already-real row — a bigger, riskier change than this fix calls for.
    // Treat it exactly as the old code did: issue a session immediately and
    // still report isNewUser so the frontend sends them to ProfileScreen.
    const isNewUser = !existingProfile.full_name;

    await this.issueSession(res, { userId: supabaseUuid, phone, firebaseUid: uid });

    return { success: true, phone, isNewUser };
  }

  /**
   * Admin-only credential login. Separate from the phone-OTP flow used by
   * every other account: admins are already a manually-provisioned
   * profiles.role = 'admin' flag (see AdminGuard), so this is a second way
   * to authenticate into that same kind of account, not a new signup path
   * — there is no self-serve way to create an admin or set this password;
   * see scripts/seed-admin.mjs.
   */
  @Post('admin-login')
  @HttpCode(200)
  async adminLogin(@Body() body: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    const profile = await this.profiles.findOne({ where: { email: body.email } });

    // Same "invalid credentials" message whether the email doesn't exist,
    // isn't an admin, or has no password set — never reveal which.
    const invalid = () => new UnauthorizedException('Invalid email or password');

    if (!profile || profile.role !== 'admin' || !profile.password_hash) {
      throw invalid();
    }

    const passwordMatches = await bcrypt.compare(body.password, profile.password_hash);
    if (!passwordMatches) {
      throw invalid();
    }

    await this.issueSession(res, { userId: profile.id, phone: profile.phone ?? undefined });

    return { success: true, redirectTo: '/admin' };
  }

  /**
   * Sends a 6-digit code to `email` — the entry point for the email-OTP
   * flow that replaced email+password signup/login (see verifyEmailOtp
   * below for the exchange). Works uniformly whether this email belongs to
   * an existing account (any signup method) or none yet; verifyEmailOtp is
   * what decides new-signup vs. existing-login, same split session() makes
   * for phone-OTP.
   *
   * Debounced at 60s per email via last_sent_at rather than a rate-limiting
   * package — consistent with this codebase's earlier decision to defer
   * that dependency. One row per email (upsert), so a second send for the
   * same email always overwrites rather than accumulating rows.
   */
  @Post('email-otp/send')
  @HttpCode(200)
  async sendEmailOtp(@Body() body: SendEmailOtpDto) {
    const email = body.email.trim().toLowerCase();

    const existing = await this.emailOtps.findOne({ where: { email } });
    if (existing) {
      const elapsedSeconds = (Date.now() - existing.last_sent_at.getTime()) / 1000;
      if (elapsedSeconds < OTP_RESEND_DEBOUNCE_SECONDS) {
        throw new BadRequestException(
          `Please wait ${Math.ceil(OTP_RESEND_DEBOUNCE_SECONDS - elapsedSeconds)}s before requesting another code.`,
        );
      }
    }

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

    return { success: true };
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
  @Post('email-otp/verify')
  @HttpCode(200)
  async verifyEmailOtp(@Body() body: VerifyEmailOtpDto, @Res({ passthrough: true }) res: Response) {
    const email = body.email.trim().toLowerCase();

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

    if (hashOtpCode(body.code) !== otp.code_hash) {
      await this.emailOtps.update({ email }, { attempt_count: otp.attempt_count + 1 });
      throw invalidCode();
    }

    // Consume the code — single use, whether this exchange is a signup or
    // a login below.
    await this.emailOtps.delete({ email });

    const existingProfile = await this.profiles.findOne({ where: { email } });

    if (!existingProfile) {
      // Genuinely new signup: no row exists for this email yet. Same
      // deferred treatment as session()'s phone-OTP path above — no row,
      // no session, until ProfileScreen completes. The eventual row's id
      // is generated at completeSignup() time instead of here, since there
      // is no longer an insert on this path to race against; see
      // completeSignup() for how a concurrent duplicate-email race is
      // handled there instead.
      const proofToken = this.issueProofToken({ email });
      return { success: true, isNewUser: true, proofToken };
    }

    // Backward compatibility: a row exists but was never completed (old
    // pre-fix code path, or a phone-signup account whose email is only now
    // being verified). Nothing left to defer — issue a session immediately,
    // same as any other existing-user login.
    const isNewUser = !existingProfile.full_name;

    await this.issueSession(res, { userId: existingProfile.id, phone: existingProfile.phone ?? undefined });

    return { success: true, isNewUser };
  }

  /**
   * The atomic "actually create the account" step for a brand-new signup —
   * called by ProfileScreen's submit, not by the OTP-verify screens. Only
   * reachable with a valid, unexpired proof-of-identity token from
   * session()/verifyEmailOtp() (see issueProofToken/verifyProofToken below);
   * there is no session cookie yet at this point; the token is what proves
   * "this phone/email was just OTP-verified" without an account existing.
   *
   * Row creation and session issuance happen together, in this one handler,
   * so there is no window where a permanent account row exists without a
   * completed profile — the exact gap this whole redesign closes. An
   * existing/returning user never reaches this endpoint: session() and
   * verifyEmailOtp() only mint a proofToken for the genuinely-new-row case,
   * and issue a real session directly for every other case (see both
   * methods above).
   */
  @Post('complete-signup')
  @HttpCode(200)
  async completeSignup(@Body() dto: CompleteSignupDto, @Res({ passthrough: true }) res: Response) {
    const claims = this.verifyProofToken(dto.proofToken);

    let userId: string;
    let phone: string | undefined;
    let firebaseUid: string | undefined;

    if (claims.firebaseUid) {
      // Phone-OTP signup — id is deterministic from the Firebase uid, same
      // derivation session() uses, so this always lands on the same row a
      // second completion attempt (or a stale duplicate token) would.
      phone = claims.phone;
      firebaseUid = claims.firebaseUid;
      userId = firebaseUidToSupabaseUuid(claims.firebaseUid);

      const alreadyExists = await this.profiles.findOne({ where: { id: userId } });
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

    await this.issueSession(res, { userId, phone, firebaseUid });

    return { success: true };
  }

  /**
   * Silently renews an expired (or about-to-expire) access token using the
   * long-lived refresh token cookie, without forcing the user through
   * phone-OTP/password again. Called by the frontend when a request comes
   * back 401 with an expired session — see web/lib/auth-fetch.ts.
   */
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!rawRefreshToken) {
      throw new UnauthorizedException('No refresh token');
    }

    // The expired access token still carries the user id even past
    // expiry — jwt.decode (unlike verify) never checks exp/signature, which
    // is fine here since the refresh token is the thing actually proving
    // who this is; the access token just tells us whose row to check.
    const rawSession = req.cookies?.[SESSION_COOKIE];
    let accessToken = rawSession;
    try {
      accessToken = JSON.parse(rawSession).access_token;
    } catch {
      // rawSession was already the bare token
    }
    const claims = accessToken ? (jwt.decode(accessToken) as jwt.JwtPayload | null) : null;
    const userId = claims?.sub;
    if (!userId) {
      throw new UnauthorizedException('No session to refresh');
    }

    const profile = await this.profiles.findOne({ where: { id: userId } });
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const notExpired =
      profile?.refresh_token_expires_at && profile.refresh_token_expires_at.getTime() > Date.now();

    if (!profile || profile.refresh_token_hash !== tokenHash || !notExpired) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    await this.issueSession(res, {
      userId: profile.id,
      phone: profile.phone ?? undefined,
      firebaseUid: claims?.firebase_uid,
    });

    return { success: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawSession = req.cookies?.[SESSION_COOKIE];
    let accessToken = rawSession;
    try {
      accessToken = JSON.parse(rawSession).access_token;
    } catch {
      // rawSession was already the bare token
    }
    const userId = accessToken ? (jwt.decode(accessToken) as jwt.JwtPayload | null)?.sub : undefined;
    if (userId) {
      // Revoke server-side so a stolen refresh-token cookie can't renew
      // sessions after logout.
      await this.profiles.update(userId, { refresh_token_hash: null, refresh_token_expires_at: null });
    }

    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie('device_id', { path: '/' });
    res.clearCookie('has_session', { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { success: true };
  }

  /** Shared by both login methods — every session this app issues has the
   *  same JWT shape and the same 3 cookies, regardless of how the caller
   *  authenticated. `role: 'authenticated'` here is the JWT's own claim
   *  (PostgREST-style), unrelated to profiles.role which is what
   *  AdminGuard actually checks. */
  private async issueSession(
    res: Response,
    opts: { userId: string; phone?: string; firebaseUid?: string },
  ): Promise<void> {
    const deviceId = crypto.randomUUID();

    const supabaseToken = jwt.sign(
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

    const rawRefreshToken = crypto.randomBytes(32).toString('hex');
    await this.profiles.update(opts.userId, {
      refresh_token_hash: hashRefreshToken(rawRefreshToken),
      refresh_token_expires_at: new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000),
    });

    const isProd = process.env.NODE_ENV === 'production';

    res.cookie(SESSION_COOKIE, JSON.stringify({ access_token: supabaseToken, refresh_token: '' }), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: WEEK_SECONDS * 1000,
      path: '/',
    });
    res.cookie(REFRESH_COOKIE, rawRefreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: REFRESH_TOKEN_SECONDS * 1000,
      path: '/',
    });
    res.cookie('device_id', deviceId, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: YEAR_SECONDS * 1000,
      path: '/',
    });
    res.cookie('has_session', '1', {
      httpOnly: false,
      secure: isProd,
      sameSite: 'lax',
      maxAge: WEEK_SECONDS * 1000,
      path: '/',
    });
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
  private issueProofToken(opts: { phone?: string; email?: string; firebaseUid?: string }): string {
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
