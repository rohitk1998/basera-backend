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
const REFRESH_TOKEN_SECONDS = YEAR_SECONDS / 12;
const REFRESH_GRACE_MS = 15_000;

const PROFILE_COMPLETION_TOKEN_MINUTES = 10;

const PROFILE_COMPLETION_TOKEN_PURPOSE = 'profile-completion';

interface ProfileCompletionClaims extends jwt.JwtPayload {
  purpose: typeof PROFILE_COMPLETION_TOKEN_PURPOSE;
  phone?: string;
  email?: string;
  firebaseUid?: string;
}

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const OTP_RESEND_DEBOUNCE_SECONDS = 60;
const OTP_MAX_ATTEMPTS = 5;

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
};

function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateOtpCode(): string {
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
}

function firebaseUidToSupabaseUuid(uid: string): string {
  const md5 = crypto.createHash('md5').update(uid).digest('hex');
  return `${md5.slice(0, 8)}-${md5.slice(8, 12)}-4${md5.slice(13, 16)}-a${md5.slice(17, 20)}-${md5.slice(20, 32)}`;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
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

  async verifyAdminCredentials(email: string, password: string): Promise<UserEntity> {
    const profile = await this.profiles.findOne({ where: { email } });

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

    const account = await this.profiles.findOne({ where: { email }, select: { id: true, full_name: true } });
    const purpose = account?.full_name ? 'login' : 'signup';

    const code = generateOtpCode();
    const now = new Date();

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

    await this.emailOtps.delete({ email });

    const existingProfile = await this.profiles.findOne({ where: { email } });

    if (!existingProfile) {
      return { isNewUser: true, email };
    }

    return { isNewUser: !existingProfile.full_name, profile: existingProfile };
  }

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
    let didInsert = false;
    let firstCompletion = false;

    if (claims.firebaseUid) {
      phone = claims.phone;
      firebaseUid = claims.firebaseUid;
      userId = firebaseUidToSupabaseUuid(claims.firebaseUid);

      const alreadyExists = await this.profiles.findOne({ where: { id: userId } });
      firstCompletion = !alreadyExists || !alreadyExists.full_name;
      if (alreadyExists) {
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
      throw new UnauthorizedException('Invalid verification token');
    }

    let avatarUrl = dto.avatar_url ?? '';
    if (avatarFile) {
      try {
        avatarUrl = await this.userService.uploadAvatarToStorage(userId, avatarFile);
        await this.profiles.update(userId, { avatar_url: avatarUrl });
      } catch (err) {
        if (didInsert) {
          await this.profiles.delete({ id: userId });
        }
        throw err;
      }
    }

    if (firstCompletion) {
      this.notifications.notify('user.welcome', userId, {
        userName: dto.name,
        isHost: dto.isHost ?? false,
        link: dto.isHost ? '/host/start' : '/stays',
      });
    }

    return { userId, phone, firebaseUid, avatar_url: avatarUrl };
  }

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

  async revokeRefreshToken(userId: string): Promise<void> {
    await this.profiles.update(userId, { refresh_token_hash: null, refresh_token_expires_at: null });
  }

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
