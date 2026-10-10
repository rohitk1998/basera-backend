import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity, VerificationRequestEntity } from '../entities';
import { SupabaseProvider } from '../auth/supabase.provider';
import { ProfilePayloadDto } from './dto/profile-payload.dto';

/** A freshly-created profile can't be edited for this many days — the fraud
 *  case is someone who just verified a phone number immediately rewriting
 *  the name/photo the KYC/banking checks (lib/domain.ts LAYER_COPY) will
 *  later be matched against. Enforced here, not just client-side. */
const PROFILE_EDIT_LOCK_DAYS = 14;
const PROFILE_EDIT_LOCK_MS = PROFILE_EDIT_LOCK_DAYS * 24 * 60 * 60 * 1000;

function editUnlocksAt(createdAt: Date | string): Date {
  return new Date(new Date(createdAt).getTime() + PROFILE_EDIT_LOCK_MS);
}

/** `isHost` is the source of truth. `role` (legacy, pre-boolean column) is
 *  read only as a fallback for a row the migration hasn't reached yet. */
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
  constructor(
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
    @InjectRepository(VerificationRequestEntity)
    private readonly verificationRequests: Repository<VerificationRequestEntity>,
    private readonly supabase: SupabaseProvider,
  ) {}

  async getProfile(userId: string) {
    const profile = await this.profiles.findOne({ where: { id: userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    // Identity approval lives in verification_requests (newest identity row
    // wins), not on `users`. Returned with the profile so every client reads
    // the same answer instead of each one re-deriving — or losing — it.
    const latestIdentity = await this.verificationRequests.findOne({
      where: { user_id: userId, verification_type: 'identity' },
      order: { submitted_at: 'DESC' },
      select: { id: true, status: true },
    });

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
        pan: profile.pan || '',
        gst: profile.gst || '',
        selfie_url: profile.selfie_url || '',
        selfie_uploaded_at: profile.selfie_uploaded_at ?? null,
        bank_upi: profile.bank_upi || '',
        bank_account_name: profile.bank_account_name || '',
        bank_verified_at: profile.bank_verified_at ?? null,
        identity_verified: latestIdentity?.status === 'verified',
      },
      editUnlocksAt: profile.created_at ? editUnlocksAt(profile.created_at).toISOString() : null,
    };
  }

  /**
   * Returns `{ isFirstTimeSignup }` on success so the controller can fire
   * the user.registered notification exactly once per account. Throws
   * ForbiddenException (mapped to 403, same as the original's hand-built
   * body) when the 14-day edit lock is still active.
   */
  async updateProfile(userId: string, dto: ProfilePayloadDto): Promise<{ isFirstTimeSignup: boolean }> {
    const existing = await this.profiles.findOne({
      where: { id: userId },
      select: { id: true, full_name: true, created_at: true },
    });

    if (!existing) {
      throw new NotFoundException('Profile not found');
    }

    // The 14-day lock guards *edits* of an already-completed profile — the
    // fraud case is someone rewriting their verified name/photo — not
    // first-time signup completion. A profile with no full_name yet has
    // never been completed, so it is exempt regardless of how old the row
    // (created at phone-verification time) already is.
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

    // `isHost` is a plain boolean write — no union/append logic needed,
    // unlike the superseded roles-array model. A signup that picks "host"
    // writes isHost: true directly; guest is already the implicit default
    // for anyone who doesn't.
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
      // Postgres' undefined_column (42703) means a migration hasn't been
      // applied yet — surfacing that distinction is what tells a developer
      // to go run the migration rather than debug the request payload.
      if (err?.code === '42703') {
        throw new InternalServerErrorException(
          `Database schema is out of date (${err.message}). Apply the latest migration.`,
        );
      }
      // email is unique-constrained — an existing user editing their email
      // to one that already belongs to a different account is a real,
      // foreseeable conflict (typo, shared family email), not a server
      // failure. Same 23505 the completeSignup() phone-signup branch
      // already guards against; this is the other place that insert can
      // collide.
      if (err?.code === '23505') {
        throw new ConflictException('An account with this email already exists.');
      }
      throw new InternalServerErrorException('Failed to update profile');
    }

    return { isFirstTimeSignup };
  }

  /**
   * Sets `isHost` on the caller's own account — the "Become a host" entry
   * point. Deliberately narrower than updateProfile above: never touches
   * name, avatar, or languages. There is no equivalent path for admin: that
   * flag is never settable through this or any other API route.
   */
  async setIsHost(userId: string, isHost: boolean) {
    await this.profiles.update({ id: userId }, { isHost });
    return { success: true, isHost };
  }

  /** Size/type checks only — no I/O. Split out from uploadAvatarToStorage so
   *  a caller (e.g. AuthService.completeSignup) can validate a picked file
   *  BEFORE committing to anything that needs rolling back on failure —
   *  these checks alone are what "too large"/unsupported
   *  type actually come from, and none of them require a userId or a
   *  storage call to evaluate. */
  validateAvatarFile(file: { size: number; mimetype: string } | null | undefined): void {
    const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    // 5 MB hard cap, enforced server-side (the client check is a UX
    // convenience only; the server is the gate). There is deliberately no
    // minimum: phone crops and small avatars are normal.
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

  /** Uploads an already-validated file to storage and returns its public
   *  URL — no DB write. Split out so completeSignup() can upload using a
   *  userId that only exists once the account row itself is created,
   *  without this method also trying to update a profiles row (which
   *  completeSignup's own insert already sets avatar_url on directly). */
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

    // Permanent public CDN URL — safe to cache forever because the path
    // ({uid}_avatar.{ext}) is stable; only the file content changes.
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
      // Storage upload succeeded — return the URL anyway. The user's
      // session will pick it up on next profile refresh even if the DB
      // write failed.
      return { publicUrl, warning: 'Profile URL not persisted' };
    }

    return { publicUrl };
  }

  /**
   * Ported from the original's fallback dedup path (the `add_fcm_token`
   * Postgres RPC was optional there — it fell back to this exact
   * read-modify-write when the RPC didn't exist). There is no RPC here at
   * all: this fallback logic is now the only/primary path.
   */
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

  /**
   * Syncs the web app's NEXT_LOCALE cookie choice onto the profile so
   * server-sent push notifications (no active request/cookie at send
   * time) can render in the recipient's language. See
   * ListingTranslationService's cache-key pattern for the same
   * "cookie is per-request, DB column is per-account" split.
   */
  async setPreferredLocale(userId: string, locale: string) {
    await this.profiles.update({ id: userId }, { preferred_locale: locale });
    return { ok: true };
  }
}
