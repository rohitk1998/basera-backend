import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type WhereExpressionBuilder } from 'typeorm';
import { BookingEntity, UserBlockEntity } from '../entities';
import type { BookingStatus } from '../common/domain';
import { findBlockRelatedUserIds } from './social-blocks.util';
import { isUuid } from './social-name.util';

/**
 * "Here" (guest list, who-is-here count, stay chat, meetups) means the stay is in progress:
 * the booking is confirmed or checked_in AND move_in <= today <= move_out in India time.
 * Not here: arriving later, already checked out or completed, requested, declined/cancelled/expired,
 * or disputed (social access is paused while a dispute is open).
 */
export const SOCIAL_ELIGIBLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'checked_in',
];

/**
 * Stories differ on purpose: a story is written after the stay, so authorship is open to guests whose
 * booking is confirmed, checked_in, checked_out or completed, with no date window. Never reuse the
 * in-progress rule for stories, and never use this list for chat or the guest list.
 */
export const STORY_AUTHOR_BOOKING_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'checked_in',
  'checked_out',
  'completed',
];

const INDIA_TIME_ZONE = 'Asia/Kolkata';

/** Calendar date (YYYY-MM-DD) in India time for the given instant. */
export function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Pure form of the in-progress rule. All arguments are YYYY-MM-DD; both ends are inclusive. */
export function isStayInProgress(
  moveIn: string,
  moveOut: string,
  today: string,
): boolean {
  return moveIn <= today && today <= moveOut;
}

/** Single source for the in-progress date rule: apply to any query builder that aliases bookings. */
export function applyInProgressWindow<T extends WhereExpressionBuilder>(
  qb: T,
  alias: string,
  now: Date = new Date(),
): T {
  // indiaToday only emits digits and dashes, so inlining it is safe and works inside subqueries.
  const today = indiaToday(now);
  return qb
    .andWhere(`${alias}.move_in <= '${today}'`)
    .andWhere(
      `COALESCE(${alias}.actual_move_out, ${alias}.move_out) >= '${today}'`,
    );
}

const NOT_A_GUEST = 'Only guests staying at this home can do this.';

@Injectable()
export class SocialAccessService {
  constructor(
    @InjectRepository(BookingEntity)
    private readonly bookingsRepo: Repository<BookingEntity>,
    @InjectRepository(UserBlockEntity)
    private readonly blocksRepo: Repository<UserBlockEntity>,
  ) {}

  /** The user has a stay in progress at the listing today (India time). */
  async assertGuestOfListing(userId: string, listingId: string): Promise<void> {
    if (!isUuid(listingId)) throw new ForbiddenException(NOT_A_GUEST);
    const qb = this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.guest_id = :userId AND b.listing_id = :listingId', {
        userId,
        listingId,
      })
      .andWhere('b.status IN (:...statuses)', {
        statuses: SOCIAL_ELIGIBLE_BOOKING_STATUSES,
      });
    applyInProgressWindow(qb, 'b');
    if ((await qb.getCount()) === 0) throw new ForbiddenException(NOT_A_GUEST);
  }

  /**
   * Story authorship: any confirmed, checked_in, checked_out or completed booking at the listing,
   * whatever the dates (see STORY_AUTHOR_BOOKING_STATUSES).
   */
  async assertStoryAuthorOfListing(
    userId: string,
    listingId: string,
  ): Promise<void> {
    if (!isUuid(listingId)) throw new ForbiddenException(NOT_A_GUEST);
    const count = await this.bookingsRepo
      .createQueryBuilder('b')
      .where('b.guest_id = :userId AND b.listing_id = :listingId', {
        userId,
        listingId,
      })
      .andWhere('b.status IN (:...statuses)', {
        statuses: STORY_AUTHOR_BOOKING_STATUSES,
      })
      .getCount();
    if (count === 0) throw new ForbiddenException(NOT_A_GUEST);
  }

  /** Start (00:00 India time) of the earliest in-progress booking's move-in; chat history before it stays hidden. */
  async earliestStayStart(
    userId: string,
    listingId: string,
  ): Promise<Date | null> {
    if (!isUuid(listingId)) return null;
    const qb = this.bookingsRepo
      .createQueryBuilder('b')
      .select('MIN(b.move_in)', 'min_move_in')
      .where('b.guest_id = :userId AND b.listing_id = :listingId', {
        userId,
        listingId,
      })
      .andWhere('b.status IN (:...statuses)', {
        statuses: SOCIAL_ELIGIBLE_BOOKING_STATUSES,
      });
    applyInProgressWindow(qb, 'b');
    const row = await qb.getRawOne<{ min_move_in: string | null }>();
    return row?.min_move_in
      ? new Date(`${row.min_move_in}T00:00:00+05:30`)
      : null;
  }

  /** Guests with a stay in progress at the listing, minus the requester and anyone blocked either way. */
  async listEligibleGuestIds(
    listingId: string,
    requesterId: string,
  ): Promise<string[]> {
    if (!isUuid(listingId)) return [];
    const qb = this.bookingsRepo
      .createQueryBuilder('b')
      .select('DISTINCT b.guest_id', 'guest_id')
      .where('b.listing_id = :listingId', { listingId })
      .andWhere('b.status IN (:...statuses)', {
        statuses: SOCIAL_ELIGIBLE_BOOKING_STATUSES,
      })
      .andWhere('b.guest_id <> :requesterId', { requesterId });
    applyInProgressWindow(qb, 'b');
    const rows = await qb.getRawMany<{ guest_id: string }>();
    if (rows.length === 0) return [];
    const blocked = await findBlockRelatedUserIds(this.blocksRepo, requesterId);
    return rows.map((r) => r.guest_id).filter((id) => !blocked.has(id));
  }
}
