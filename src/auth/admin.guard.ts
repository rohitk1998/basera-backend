import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request } from 'express';
import { UserEntity } from '../entities';
import { AuthGuard } from './auth.guard';
import { Role } from '../common/domain';

const VALID_ROLES: readonly Role[] = ['host', 'admin'];
function isRole(value: string): value is Role {
  return (VALID_ROLES as readonly string[]).includes(value);
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly authGuard: AuthGuard,
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
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
