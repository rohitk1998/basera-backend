import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthUser } from './types';

export const SESSION_COOKIE = 'sb-dkmlkbhwzvexwdgxpexg-auth-token';

/**
 * Ported from web/lib/auth.server.ts requireAuth(). The cookie is named to
 * look like a native Supabase SSR auth cookie but holds this app's own
 * custom-signed JWT (see AuthController.session) — same shape here.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    req.user = this.verify(req);
    return true;
  }

  verify(req: Request): AuthUser {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (!raw) {
      throw new UnauthorizedException('No session cookie found');
    }

    let token = raw;
    try {
      token = JSON.parse(raw).access_token;
    } catch {
      // raw was already the bare token
    }

    try {
      const decoded = jwt.verify(
        token,
        this.config.get<string>('SUPABASE_JWT_SECRET')!,
      ) as jwt.JwtPayload;

      if (!decoded.sub) throw new Error('No user ID in token');

      return { userId: decoded.sub, phone: decoded.phone_number as string | undefined };
    } catch (err) {
      // Distinguish "expired" (code: 'session_expired') from anything else
      // so the frontend's fetch wrapper knows an /api/auth/refresh retry is
      // worth attempting rather than sending the user straight to login —
      // see web/lib/auth-fetch.ts.
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException({ code: 'session_expired', message: 'Session expired' });
      }
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}
