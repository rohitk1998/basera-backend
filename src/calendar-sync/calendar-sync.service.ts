import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { BookingEntity, ListingEntity } from '../entities';
import { findConflicts } from '../listings/availability.util';
import { loadBufferDays, widenedWindow } from '../listings/buffer-days.util';
import { ListingCalendarBlockEntity } from './calendar-block.entity';
import { ListingCalendarSyncEntity } from './calendar-sync.entity';
import { assertIcalBody, buildIcs, parseIcs, type IcsEvent } from './ics.util';
import { UnsafeUrlError, assertSafeImportUrl, fetchCalendarText } from './safe-fetch.util';

// Only dates that are actually taken. Unconfirmed requests are not exported (no phantom blocks in other calendars).
const EXPORT_STATUSES = ['approved', 'confirmed', 'checked_in', 'disputed', 'completed', 'checked_out'];

const newToken = () => randomBytes(24).toString('hex');

@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    @InjectRepository(ListingCalendarSyncEntity) private readonly syncRepo: Repository<ListingCalendarSyncEntity>,
    @InjectRepository(ListingCalendarBlockEntity) private readonly blocksRepo: Repository<ListingCalendarBlockEntity>,
    @InjectRepository(BookingEntity) private readonly bookingsRepo: Repository<BookingEntity>,
    @InjectRepository(ListingEntity) private readonly listingsRepo: Repository<ListingEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async assertHost(listingId: string, userId: string): Promise<void> {
    const listing = await this.listingsRepo.findOne({ where: { id: listingId }, select: { id: true, host_id: true } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.host_id !== userId) throw new ForbiddenException('This is not your listing.');
  }

  private async getOrCreate(listingId: string): Promise<ListingCalendarSyncEntity> {
    const existing = await this.syncRepo.findOne({ where: { listing_id: listingId } });
    if (existing) return existing;
    await this.syncRepo
      .createQueryBuilder()
      .insert()
      .values({ listing_id: listingId, export_token: newToken() })
      .orIgnore()
      .execute();
    return this.syncRepo.findOneOrFail({ where: { listing_id: listingId } });
  }

  private async toStatus(row: ListingCalendarSyncEntity) {
    const blockCount = await this.blocksRepo.count({ where: { listing_id: row.listing_id } });
    return {
      exportPath: `/api/calendar/${row.listing_id}/${row.export_token}.ics`,
      importUrl: row.import_url,
      lastSyncedAt: row.last_synced_at,
      lastSyncError: row.last_sync_error,
      blockCount,
    };
  }

  async getStatus(listingId: string, userId: string) {
    await this.assertHost(listingId, userId);
    return this.toStatus(await this.getOrCreate(listingId));
  }

  async setImportUrl(listingId: string, userId: string, rawUrl: string | null) {
    await this.assertHost(listingId, userId);
    const row = await this.getOrCreate(listingId);
    const trimmed = rawUrl?.trim();
    if (!trimmed) {
      await this.dataSource.transaction(async (m) => {
        await m.delete(ListingCalendarBlockEntity, { listing_id: listingId });
        await m.update(ListingCalendarSyncEntity, { listing_id: listingId }, { import_url: null, last_synced_at: null, last_sync_error: null });
      });
    } else {
      try {
        assertSafeImportUrl(trimmed);
      } catch (err) {
        throw new BadRequestException(err instanceof UnsafeUrlError ? err.message : 'Invalid URL.');
      }
      await this.syncRepo.update({ listing_id: listingId }, { import_url: trimmed, last_sync_error: null });
    }
    return this.toStatus(await this.syncRepo.findOneOrFail({ where: { listing_id: row.listing_id } }));
  }

  async rotateToken(listingId: string, userId: string) {
    await this.assertHost(listingId, userId);
    await this.getOrCreate(listingId);
    await this.syncRepo.update({ listing_id: listingId }, { export_token: newToken() });
    return this.toStatus(await this.syncRepo.findOneOrFail({ where: { listing_id: listingId } }));
  }

  async syncNow(listingId: string, userId: string) {
    await this.assertHost(listingId, userId);
    const row = await this.getOrCreate(listingId);
    if (!row.import_url) throw new BadRequestException('Save an import calendar link first.');
    await this.syncListing(row, true);
    return this.toStatus(await this.syncRepo.findOneOrFail({ where: { listing_id: listingId } }));
  }

  /** Fetches the external feed and swaps in its ranges. On failure the previous blocks stay and the error is recorded. */
  private async syncListing(row: ListingCalendarSyncEntity, throwOnError: boolean): Promise<void> {
    if (!row.import_url) return;
    try {
      const ranges = parseIcs(assertIcalBody(await fetchCalendarText(row.import_url)));
      await this.dataSource.transaction(async (m) => {
        await m.delete(ListingCalendarBlockEntity, { listing_id: row.listing_id });
        if (ranges.length > 0) {
          await m.insert(
            ListingCalendarBlockEntity,
            ranges.map((r) => ({ listing_id: row.listing_id, uid: r.uid, starts_on: r.start, ends_on: r.end })),
          );
        }
        await m.update(ListingCalendarSyncEntity, { listing_id: row.listing_id }, { last_synced_at: new Date(), last_sync_error: null });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed.';
      await this.syncRepo.update({ listing_id: row.listing_id }, { last_sync_error: message.slice(0, 300) });
      if (throwOnError) throw new BadGatewayException(`Could not read that calendar: ${message}`);
      this.logger.warn(`sync failed for listing ${row.listing_id}: ${message}`);
    }
  }

  async syncAll(): Promise<void> {
    const rows = await this.syncRepo.find({ where: { import_url: Not(IsNull()) } });
    for (const row of rows) await this.syncListing(row, false);
  }

  /** Throws ConflictException when the stay overlaps a block imported from the host's external calendar. */
  async assertDatesFree(listingId: string, moveIn: string, moveOut: string): Promise<void> {
    const buffer = await loadBufferDays(this.dataSource, listingId);
    const w = buffer > 0 ? widenedWindow(moveIn, moveOut) : { start: moveIn, end: moveOut };
    const rows = await this.blocksRepo
      .createQueryBuilder('b')
      .where('b.listing_id = :listingId', { listingId })
      .andWhere('b.starts_on < :moveOut', { moveOut: w.end })
      .andWhere('b.ends_on > :moveIn', { moveIn: w.start })
      .getMany();
    const clash = findConflicts(
      rows.map((r) => ({ start: String(r.starts_on), end: String(r.ends_on) })),
      { start: moveIn, end: moveOut },
      buffer,
    ).length > 0;
    if (clash) throw new ConflictException('This property is not available for the selected dates.');
  }

  async buildFeed(listingId: string, token: string): Promise<string> {
    const row = await this.syncRepo.findOne({ where: { listing_id: listingId } });
    const a = Buffer.from(row?.export_token ?? '');
    const b = Buffer.from(token);
    if (!row || a.length !== b.length || !timingSafeEqual(a, b)) throw new NotFoundException();

    const bookings = await this.bookingsRepo
      .createQueryBuilder('b')
      .select(['b.id', 'b.move_in', 'b.move_out', 'b.actual_move_out', 'b.status'])
      .where('b.listing_id = :listingId', { listingId })
      .andWhere('b.status IN (:...statuses)', { statuses: EXPORT_STATUSES })
      .getMany();

    // Imported blocks are deliberately not re-exported: that would echo the host's own calendar back at it.
    const events: IcsEvent[] = bookings.map((b) => {
      const end = b.actual_move_out && b.actual_move_out > b.move_in ? b.actual_move_out : b.move_out;
      return {
        uid: `booking-${b.id}@RhenBasera`,
        summary: 'RhenBasera booking',
        start: b.move_in,
        end,
      };
    });
    return buildIcs('RhenBasera bookings', events);
  }
}
