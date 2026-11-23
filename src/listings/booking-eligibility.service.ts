import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { ListingEntity } from '../entities';
import { ListingHistoryService } from './listing-history.service';
import { ListingsService } from './listings.service';

export const setEligibilitySchema = z.object({
  eligible: z.boolean({ message: 'eligible must be true or false.' }),
  reason: z.string().trim().max(500).optional(),
});

@Injectable()
export class BookingEligibilityService {
  constructor(
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    private readonly history: ListingHistoryService,
    private readonly listingsService: ListingsService,
  ) {}

  /** Admin-only (the controller is behind AdminGuard). Enabling requires a live, claimed listing. */
  async set(listingId: string, adminId: string, body: unknown) {
    const parsed = setEligibilitySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid request.');
    const { eligible, reason } = parsed.data;

    const row = await this.listings.findOne({ where: { id: listingId } });
    if (!row) throw new NotFoundException('Listing not found');
    if (eligible && (row.status !== 'live' || row.is_discovered)) {
      throw new ConflictException('Only a live, claimed listing can be opened for booking.');
    }
    if (row.booking_eligible === eligible) return { listingId, bookingEligible: eligible };

    await this.listings.update({ id: listingId }, { booking_eligible: eligible, updated_at: new Date() });
    await this.history.record({
      listingId,
      from: row.status,
      to: eligible ? 'booking_enabled' : 'booking_disabled',
      actorId: adminId,
      reason,
    });
    await this.listingsService.bumpSearchCacheVersion();
    return { listingId, bookingEligible: eligible };
  }
}
