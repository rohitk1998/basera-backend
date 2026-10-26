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

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

const WEEK_SECONDS = 60 * 60 * 24 * 7;
const YEAR_SECONDS = 60 * 60 * 24 * 365;
const REFRESH_TOKEN_SECONDS = YEAR_SECONDS / 12;

const REFRESH_COOKIE = 'basera_refresh_token';

@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  @Get('realtime-token')
  @UseGuards(AuthGuard)
  realtimeToken(@Req() req: Request) {
    const raw = req.cookies?.[SESSION_COOKIE];
    let token = raw;
    try {
      token = JSON.parse(raw).access_token;
    } catch {
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
      const proofToken = this.auth.issueProofToken({ phone, firebaseUid: uid });
      return { success: true, phone, isNewUser: true, proofToken };
    }

    const isNewUser = !existingProfile.full_name;

    await this.setSessionCookies(res, await this.auth.issueSession({ userId, phone, firebaseUid: uid }));

    return { success: true, phone, isNewUser };
  }

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

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Verification code sent to your email.')
  @Post('email-otp/send')
  @HttpCode(200)
  async sendEmailOtp(@Body() body: SendEmailOtpDto) {
    await this.auth.sendEmailOtp(body.email);
    return { success: true };
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage((r) => (r.isNewUser ? 'Email verified. Finish setting up your profile.' : 'Signed in.'))
  @Post('email-otp/verify')
  @HttpCode(200)
  async verifyEmailOtp(@Body() body: VerifyEmailOtpDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.verifyEmailOtp(body.email, body.code);

    if (!('profile' in result)) {
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

  @ResponseMessage('Session refreshed.')
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!rawRefreshToken) {
      throw new UnauthorizedException('No refresh token');
    }

    const rawSession = req.cookies?.[SESSION_COOKIE];
    let accessToken = rawSession;
    try {
      accessToken = JSON.parse(rawSession).access_token;
    } catch {
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
