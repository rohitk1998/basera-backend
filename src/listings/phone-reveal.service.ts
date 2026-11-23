import { ForbiddenException, Injectable, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ListingEntity, PhoneRevealLogEntity, UserEntity } from '../entities';
import { assertVerifiedContact } from '../common/contact-gate.util';
import { buildWhatsappUrl } from '../common/whatsapp-link.util';
import { rowToListing } from './listing-mapper';

export const MAX_UNIQUE_REVEALS_PER_DAY = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PhoneRevealService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async reveal(userId: string, listingId: string, ip: string | undefined) {
    const guest = await this.users.findOne({
      where: { id: userId },
      select: { id: true, phone: true, email_verified_at: true, banned_at: true },
    });
    assertVerifiedContact(guest);

    const listing = await this.listings.findOne({
      where: { id: listingId },
      select: { id: true, host_id: true, status: true, is_discovered: true, draft_data: true },
    });
    if (!listing || listing.status !== 'live' || listing.is_discovered || !listing.host_id) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.host_id === userId) {
      throw new ForbiddenException('This is your own listing.');
    }

    const host = await this.users.findOne({
      where: { id: listing.host_id },
      select: { id: true, phone: true, banned_at: true },
    });
    if (!host?.phone || host.banned_at) {
      throw new NotFoundException('This host has no phone number on file. Send a message instead.');
    }

    const ipHash = ip
      ? createHash('sha256').update(`${ip}|${this.config.get<string>('SUPABASE_JWT_SECRET') ?? ''}`).digest('hex')
      : null;

    // Serialise per guest so two parallel taps cannot both slip under the cap.
    await this.dataSource.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`reveal:${userId}`]);
      const since = new Date(Date.now() - WINDOW_MS);
      const rows: { host_id: string }[] = await em.query(
        'SELECT DISTINCT host_id FROM phone_reveal_logs WHERE guest_id = $1 AND revealed_at >= $2',
        [userId, since],
      );
      const alreadySeen = rows.some((r) => r.host_id === listing.host_id);
      if (alreadySeen) return;
      if (rows.length >= MAX_UNIQUE_REVEALS_PER_DAY) {
        throw new HttpException(
          `You can view up to ${MAX_UNIQUE_REVEALS_PER_DAY} host phone numbers per 24 hours. Message the host instead, or try again later.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await em.insert(PhoneRevealLogEntity, {
        guest_id: userId,
        host_id: listing.host_id,
        listing_id: listing.id,
        ip_hash: ipHash,
      });
    });

    return {
      success: true,
      phone: host.phone,
      whatsappUrl: buildWhatsappUrl(host.phone, rowToListing(listing).title),
    };
  }
}
