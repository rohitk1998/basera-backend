import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
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
import { ProfileEntity } from '../entities';
import { AuthGuard, SESSION_COOKIE } from './auth.guard';
import { AdminLoginDto } from './dto/admin-login.dto';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

const PASSWORD_HASH_ROUNDS = 12;

const WEEK_SECONDS = 60 * 60 * 24 * 7;
const YEAR_SECONDS = 60 * 60 * 24 * 365;

// Deterministic Firebase UID -> Supabase-shaped UUID mapping. Ported as-is
// from web/app/api/auth/session/route.ts — changing the derivation would
// orphan every existing profile row from its Firebase account.
function firebaseUidToSupabaseUuid(uid: string): string {
  const md5 = crypto.createHash('md5').update(uid).digest('hex');
  return `${md5.slice(0, 8)}-${md5.slice(8, 12)}-4${md5.slice(13, 16)}-a${md5.slice(17, 20)}-${md5.slice(20, 32)}`;
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly firebase: FirebaseAdminProvider,
    private readonly config: ConfigService,
    @InjectRepository(ProfileEntity)
    private readonly profiles: Repository<ProfileEntity>,
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

    let isNewUser = false;
    if (!existingProfile) {
      isNewUser = true;
      await this.profiles.insert({ id: supabaseUuid, phone });
    } else if (!existingProfile.full_name) {
      isNewUser = true;
    }

    this.issueSession(res, { userId: supabaseUuid, phone, firebaseUid: uid });

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

    this.issueSession(res, { userId: profile.id, phone: profile.phone ?? undefined });

    return { success: true, redirectTo: '/admin' };
  }

  /**
   * Email+password signup for guests/hosts — an alternative entry point to
   * phone-OTP, not a replacement. Emails must be globally unique across
   * every account regardless of how it was created: a phone-OTP account
   * that already has this email on file (collected at profile completion)
   * blocks the signup rather than attaching a password to that existing
   * row. Attaching a password to an existing account with no proof the
   * caller owns it would be an account-takeover hole, so that is
   * deliberately not supported here — a user who wants password login on
   * an account they made via phone would need a logged-in "set a
   * password" action instead (not built yet).
   */
  @Post('signup')
  async signup(@Body() body: SignupDto, @Res({ passthrough: true }) res: Response) {
    const existing = await this.profiles.findOne({ where: { email: body.email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(body.password, PASSWORD_HASH_ROUNDS);
    const id = crypto.randomUUID();

    try {
      await this.profiles.insert({ id, email: body.email, password_hash: passwordHash });
    } catch (err: any) {
      // Race: two signups for the same email landed between the check
      // above and this insert. The DB unique constraint is the real
      // guard; the findOne above is just the friendly error path.
      if (err?.code === '23505') {
        throw new ConflictException('An account with this email already exists.');
      }
      throw err;
    }

    this.issueSession(res, { userId: id });

    return { success: true, isNewUser: true };
  }

  /** Email+password login for guest/host accounts created via signup()
   *  above. A phone-OTP account with an email on file but no password
   *  set cannot log in here — see signup()'s comment. */
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const profile = await this.profiles.findOne({ where: { email: body.email } });

    const invalid = () => new UnauthorizedException('Invalid email or password');

    if (!profile || !profile.password_hash) {
      throw invalid();
    }

    const passwordMatches = await bcrypt.compare(body.password, profile.password_hash);
    if (!passwordMatches) {
      throw invalid();
    }

    this.issueSession(res, { userId: profile.id, phone: profile.phone ?? undefined });

    return { success: true };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie('device_id', { path: '/' });
    res.clearCookie('has_session', { path: '/' });
    return { success: true };
  }

  /** Shared by both login methods — every session this app issues has the
   *  same JWT shape and the same 3 cookies, regardless of how the caller
   *  authenticated. `role: 'authenticated'` here is the JWT's own claim
   *  (PostgREST-style), unrelated to profiles.role which is what
   *  AdminGuard actually checks. */
  private issueSession(
    res: Response,
    opts: { userId: string; phone?: string; firebaseUid?: string },
  ): void {
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

    const isProd = process.env.NODE_ENV === 'production';

    res.cookie(SESSION_COOKIE, JSON.stringify({ access_token: supabaseToken, refresh_token: '' }), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: WEEK_SECONDS * 1000,
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
}
