import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { ProfileEntity } from '../entities';
import { AuthGuard } from './auth.guard';
import { Role } from '../common/domain';

const VALID_ROLES: readonly Role[] = ['host', 'admin'];
function isRole(value: string): value is Role {
  return (VALID_ROLES as readonly string[]).includes(value);
}

/**
 * Ported from web/lib/auth.server.ts requireAdmin(). Reads admin status
 * from profiles.role — the only source of truth for "is this user an
 * admin". Never granted by any code path; manually provisioned via direct
 * SQL only.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly authGuard: AuthGuard,
    @InjectRepository(ProfileEntity)
    private readonly profiles: Repository<ProfileEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    req.user = this.authGuard.verify(req);

    const profile = await this.profiles.findOne({ where: { id: req.user.userId } });
    if (!profile) {
      throw new ForbiddenException('No profile found for user');
    }

    const rawRoles: unknown[] = typeof profile.role === 'string' ? [profile.role] : [];

    const roles = rawRoles
      .filter((r): r is string => typeof r === 'string')
      .filter(isRole);

    if (!roles.includes('admin')) {
      throw new ForbiddenException('Admin role required');
    }

    return true;
  }
}
