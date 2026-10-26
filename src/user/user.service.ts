import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity, VerificationRequestEntity } from '../entities';
import { SupabaseProvider } from '../auth/supabase.provider';
import { ProfilePayloadDto } from './dto/profile-payload.dto';

const PROFILE_EDIT_LOCK_DAYS = 14;
const PROFILE_EDIT_LOCK_MS = PROFILE_EDIT_LOCK_DAYS * 24 * 60 * 60 * 1000;

function editUnlocksAt(createdAt: Date | string): Date {
  return new Date(new Date(createdAt).getTime() + PROFILE_EDIT_LOCK_MS);
}

function resolveIsHost(profile: { isHost?: unknown; role?: unknown }): boolean {
  if (typeof profile.isHost === 'boolean') return profile.isHost;
  return profile.role === 'host';
}

function resolveIsAdmin(profile: { role?: unknown }): boolean {
  return profile.role === 'admin';
}

export interface ProfileEditLockedError {
  error: string;
  editUnlocksAt: string;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private warnedMissingWelcomeColumn = false;

  constructor(
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    @InjectRepository(VerificationRequestEntity)
    private readonly verificationRequests: Repository<VerificationRequestEntity>,
    private readonly supabase: SupabaseProvider,
  ) {}

  async markWelcomeSeen(userId: string) {
    try {
      await this.profiles.manager.query(
        'update users set welcome_seen_at = now() where id = $1 and welcome_seen_at is null',
        [userId],
      );
    } catch (err) {
      const code = (err as { code?: string; driverError?: { code?: string } })?.code
        ?? (err as { driverError?: { code?: string } })?.driverError?.code;
      if (code !== '42703') throw err;
      if (!this.warnedMissingWelcomeColumn) {
        this.warnedMissingWelcomeColumn = true;
        this.logger.warn('users.welcome_seen_at is missing - apply migrations/20261014_user_welcome_seen.sql');
      }
    }
    return { success: true };
  }

  private async readWelcomeSeenAt(userId: string): Promise<string | null | undefined> {
    try {
      const rows: Array<{ welcome_seen_at: Date | string | null }> =
        await this.profiles.manager.query('select welcome_seen_at from users where id = $1', [userId]);
      const v = rows?.[0]?.welcome_seen_at;
      if (v === null || v === undefined) return null;
      return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
    } catch (err) {
      const code = (err as { code?: string; driverError?: { code?: string } })?.code
        ?? (err as { driverError?: { code?: string } })?.driverError?.code;
      if (code !== '42703') throw err;
      return undefined;
    }
  }

  async getProfile(userId: string) {
    const profile = await this.profiles.findOne({ where: { id: userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    const latestIdentity = await this.verificationRequests.findOne({
      where: { user_id: userId, verification_type: 'identity' },
      order: { submitted_at: 'DESC' },
      select: { id: true, status: true },
    });

    const welcomeSeenAt = await this.readWelcomeSeenAt(userId);

    return {
      success: true,
      profile: {
        id: profile.id,
        phone: profile.phone,
        full_name: profile.full_name,
        email: profile.email || '',
        languages: profile.languages || [],
        isHost: resolveIsHost(profile),
        isAdmin: resolveIsAdmin(profile),
        avatar_url: profile.avatar_url || '',
        created_at: profile.created_at,
        host_kind: profile.host_kind ?? null,
        gst: profile.gst || '',
        selfie_url: profile.selfie_url || '',
        selfie_uploaded_at: profile.selfie_uploaded_at ?? null,
        identity_verified: latestIdentity?.status === 'verified',
        ...(welcomeSeenAt !== undefined && { welcomeSeenAt }),
      },
      editUnlocksAt: profile.created_at ? editUnlocksAt(profile.created_at).toISOString() : null,
    };
  }

  async updateProfile(userId: string, dto: ProfilePayloadDto): Promise<{ isFirstTimeSignup: boolean }> {
    const existing = await this.profiles.findOne({
      where: { id: userId },
      select: { id: true, full_name: true, created_at: true },
    });

    if (!existing) {
      throw new NotFoundException('Profile not found');
    }

    const isFirstTimeSignup = !existing.full_name;

    if (existing.full_name && existing.created_at) {
      const unlocksAt = editUnlocksAt(existing.created_at);
      if (Date.now() < unlocksAt.getTime()) {
        throw new ForbiddenException({
          error: `Your profile can be edited again on ${unlocksAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
          editUnlocksAt: unlocksAt.toISOString(),
        });
      }
    }

    try {
      await this.profiles.update(
        { id: userId },
        {
          full_name: dto.name,
          email: dto.email,
          languages: dto.languages,
          isHost: dto.isHost ?? false,
          avatar_url: dto.avatar_url,
        },
      );
    } catch (err: any) {
      if (err?.code === '42703') {
        throw new InternalServerErrorException(
          `Database schema is out of date (${err.message}). Apply the latest migration.`,
        );
      }
      if (err?.code === '23505') {
        throw new ConflictException('An account with this email already exists.');
      }
      throw new InternalServerErrorException('Failed to update profile');
    }

    return { isFirstTimeSignup };
  }

  async setIsHost(userId: string, isHost: boolean) {
    await this.profiles.update({ id: userId }, { isHost });
    return { success: true, isHost };
  }

  validateAvatarFile(file: { size: number; mimetype: string } | null | undefined): void {
    const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const MAX_BYTES = 5 * 1024 * 1024;

    if (!file || file.size === 0) {
      throw new BadRequestException('No file provided');
    }
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Unsupported file type. Use JPEG, PNG, WebP or GIF.');
    }
    if (file.size > MAX_BYTES) {
      throw new PayloadTooLargeException('File too large. Maximum size is 5 MB.');
    }
  }

  async uploadAvatarToStorage(userId: string, file: { buffer: Buffer; mimetype: string }): Promise<string> {
    const EXT_MAP: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    const ext = EXT_MAP[file.mimetype];
    const storagePath = `${userId}_avatar.${ext}`;

    const { error: uploadError } = await this.supabase.client.storage
      .from('avatars')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      throw new InternalServerErrorException('Upload failed. Please try again.');
    }

    const {
      data: { publicUrl },
    } = this.supabase.client.storage.from('avatars').getPublicUrl(storagePath);

    return publicUrl;
  }

  async uploadAvatar(userId: string, file: { buffer: Buffer; mimetype: string; size: number }) {
    this.validateAvatarFile(file);
    const publicUrl = await this.uploadAvatarToStorage(userId, file);

    try {
      await this.profiles.update({ id: userId }, { avatar_url: publicUrl });
    } catch {
      return { publicUrl, warning: 'Profile URL not persisted' };
    }

    return { publicUrl };
  }

  async addPushToken(userId: string, token: string) {
    const profile = await this.profiles.findOne({ where: { id: userId }, select: { id: true, fcm_tokens: true } });
    const existing: string[] = profile?.fcm_tokens ?? [];
    if (!existing.includes(token)) {
      await this.profiles.update(
        { id: userId },
        { fcm_tokens: [...existing, token], notif_updated_at: new Date() },
      );
    }
    return { ok: true };
  }

  async removePushToken(userId: string, token: string) {
    const profile = await this.profiles.findOne({ where: { id: userId }, select: { id: true, fcm_tokens: true } });
    const existing: string[] = profile?.fcm_tokens ?? [];
    await this.profiles.update(
      { id: userId },
      { fcm_tokens: existing.filter((t) => t !== token), notif_updated_at: new Date() },
    );
    return { ok: true };
  }

  async setPreferredLocale(userId: string, locale: string) {
    await this.profiles.update({ id: userId }, { preferred_locale: locale });
    return { ok: true };
  }
}
