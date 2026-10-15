import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthGuard, SESSION_COOKIE } from './auth.guard';
import { AuthService, AvatarUploadFile, SessionTokens } from './auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { SendEmailOtpDto } from './dto/send-email-otp.dto';
import { VerifyEmailOtpDto } from './dto/verify-email-otp.dto';
import { CompleteSignupDto } from './dto/complete-signup.dto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

interface UploadedMulterFile {
  buffer?: Buffer;
  mimetype: string;
  size: number;
}

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // matches UserService.uploadAvatar's own cap

const WEEK_SECONDS = 60 * 60 * 24 * 7;
const YEAR_SECONDS = 60 * 60 * 24 * 365;
const REFRESH_TOKEN_SECONDS = YEAR_SECONDS / 12; // 30 days — outlives the 7-day access token so it can renew it

const REFRESH_COOKIE = 'basera_refresh_token';

/**
 * HTTP layer only — reads the request, calls AuthService for every bit of
 * actual business logic (bcrypt/jwt/OTP handling, repository access), and
 * shapes cookies/responses from what AuthService returns. AuthService never
 * touches Request/Response, so every cookie write stays here.
 */
@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

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

  @ResponseMessage((r) => (r.isNewUser ? 'Phone verified. Finish setting up your profile.' : 'Signed in.'))
  @Post('session')
  async session(
    @Body('firebaseToken') firebaseToken: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!firebaseToken) {
      throw new BadRequestException('No token provided');
    }

    const decodedToken = await this.auth.verifyFirebaseToken(firebaseToken);

    const { uid } = decodedToken;
    const phone = decodedToken.phone_number;
    if (!phone) {
      throw new BadRequestException('No phone number found on token');
    }

    const userId = this.auth.firebaseUidToUserId(uid);
    const existingProfile = await this.auth.findProfileById(userId);

    if (!existingProfile) {
      // Genuinely new signup: no row exists for this Firebase identity yet.
      // Defer row creation and session issuance until ProfileScreen submits
      // name/languages/avatar — see completeSignup() below. Hand back a
      // short-lived proof-of-identity token instead of a session so the
      // frontend can prove "this phone/uid was just OTP-verified" without
      // us having created an account or signed anyone in yet.
      const proofToken = this.auth.issueProofToken({ phone, firebaseUid: uid });
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

    await this.setSessionCookies(res, await this.auth.issueSession({ userId, phone, firebaseUid: uid }));

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
  // Tighter than the 60/min global default — a bcrypt.compare admin-login
  // endpoint is exactly what brute-force rate limiting exists for, and
  // there was previously no limit on it at all.
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ResponseMessage('Signed in as admin.')
  @Post('admin-login')
  @HttpCode(200)
  async adminLogin(@Body() body: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    const profile = await this.auth.verifyAdminCredentials(body.email, body.password);

    await this.setSessionCookies(
      res,
      await this.auth.issueSession({ userId: profile.id, phone: profile.phone ?? undefined }),
    );

    return { success: true, redirectTo: '/admin' };
  }

  /**
   * Sends a 6-digit code to `email` — the entry point for the email-OTP
   * flow that replaced email+password signup/login (see verifyEmailOtp
   * below for the exchange). Works uniformly whether this email belongs to
   * an existing account (any signup method) or none yet; verifyEmailOtp is
   * what decides new-signup vs. existing-login, same split session() makes
   * for phone-OTP.
   */
  // The 60s-per-email debounce (inside AuthService.sendEmailOtp) stops
  // repeat sends to the *same* address; it does nothing against one
  // attacker cycling through many addresses. This IP-scoped limit covers
  // that gap.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Verification code sent to your email.')
  @Post('email-otp/send')
  @HttpCode(200)
  async sendEmailOtp(@Body() body: SendEmailOtpDto) {
    await this.auth.sendEmailOtp(body.email);
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
  // OTP_MAX_ATTEMPTS (inside AuthService) already caps guesses against one
  // email/code; this IP-scoped limit caps how many different codes one
  // caller can attempt across many emails in a burst.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage((r) => (r.isNewUser ? 'Email verified. Finish setting up your profile.' : 'Signed in.'))
  @Post('email-otp/verify')
  @HttpCode(200)
  async verifyEmailOtp(@Body() body: VerifyEmailOtpDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.verifyEmailOtp(body.email, body.code);

    if (!('profile' in result)) {
      // Genuinely new signup — same deferred treatment as session()'s
      // phone-OTP path: no row, no session, until ProfileScreen completes.
      const proofToken = this.auth.issueProofToken({ email: result.email });
      return { success: true, isNewUser: true, proofToken };
    }

    await this.setSessionCookies(
      res,
      await this.auth.issueSession({
        userId: result.profile.id,
        phone: result.profile.phone ?? undefined,
      }),
    );

    return { success: true, isNewUser: result.isNewUser };
  }

  /**
   * The atomic "actually create the account" step for a brand-new signup —
   * called by ProfileScreen's submit, not by the OTP-verify screens. Only
   * reachable with a valid, unexpired proof-of-identity token from
   * session()/verifyEmailOtp(). Row creation and session issuance happen
   * together (inside AuthService.completeSignup + the setSessionCookies
   * call below), so there is no window where a permanent account row
   * exists without a completed profile.
   *
   * Multipart, not JSON: the picked avatar photo (if any) rides along in
   * the same request that creates the account, so AuthService can validate
   * and upload it as part of one atomic completeSignup() call instead of a
   * separate follow-up request made after the account already exists — see
   * AuthService.completeSignup's doc comment for why that used to let
   * signup "succeed" while silently dropping a photo. `languages` arrives
   * JSON-stringified (multipart has no native array field), same pattern
   * VerificationController.parseBankDetails already uses for its own
   * JSON-in-a-multipart-field case.
   */
  @ResponseMessage('Your account is ready.')
  @Post('complete-signup')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('avatar', { limits: { fileSize: AVATAR_MAX_BYTES } }))
  async completeSignup(
    @Body('name') name: string,
    @Body('email') email: string,
    @Body('languages') languagesJson: string,
    @Body('isHost') isHostRaw: string | undefined,
    @Body('proofToken') proofToken: string,
    @UploadedFile() file: UploadedMulterFile | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    let languages: unknown;
    try {
      languages = JSON.parse(languagesJson ?? '[]');
    } catch {
      throw new BadRequestException('languages must be valid JSON.');
    }

    const dto = plainToInstance(CompleteSignupDto, {
      name,
      email,
      languages,
      isHost: isHostRaw === 'true',
      proofToken,
    });
    const errors = await validate(dto, { whitelist: true });
    if (errors.length > 0) {
      const message = errors.flatMap((e) => Object.values(e.constraints ?? {})).join(' ');
      throw new BadRequestException(message || 'Invalid request.');
    }

    const avatarFile: AvatarUploadFile | undefined =
      file?.buffer && file.buffer.length > 0
        ? { buffer: file.buffer, mimetype: file.mimetype, size: file.size }
        : undefined;

    const { userId, phone, firebaseUid, avatar_url } = await this.auth.completeSignup(dto, avatarFile);
    await this.setSessionCookies(res, await this.auth.issueSession({ userId, phone, firebaseUid }));
    return { success: true, avatar_url, userId };
  }

  /**
   * Silently renews an expired (or about-to-expire) access token using the
   * long-lived refresh token cookie, without forcing the user through
   * phone-OTP/password again. Called by the frontend when a request comes
   * back 401 with an expired session — see web/lib/auth-fetch.ts.
   */
  @ResponseMessage('Session refreshed.')
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

    await this.setSessionCookies(res, await this.auth.rotateSession(userId, rawRefreshToken, claims?.firebase_uid));

    return { success: true };
  }

  @ResponseMessage('Signed out.')
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
      await this.auth.revokeRefreshToken(userId);
    }

    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie('device_id', { path: '/' });
    res.clearCookie('has_session', { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { success: true };
  }

  /** Shared by every path above that issues a session — the same 4 cookies,
   *  the same shape, regardless of how the caller authenticated. */
  private async setSessionCookies(res: Response, tokens: SessionTokens): Promise<void> {
    const isProd = process.env.NODE_ENV === 'production';

    res.cookie(SESSION_COOKIE, JSON.stringify({ access_token: tokens.accessToken, refresh_token: '' }), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: WEEK_SECONDS * 1000,
      path: '/',
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: REFRESH_TOKEN_SECONDS * 1000,
      path: '/',
    });
    res.cookie('device_id', tokens.deviceId, {
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
