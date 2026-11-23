import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BookingEntity, ListingEntity } from '../entities';
import { GuidebookEntity, GuidebookSection } from './guidebook.entity';
import { UpdateGuidebookDto } from './dto/update-guidebook.dto';

// A guest unlocks the guidebook once the stay is confirmed (paid/held), in
// progress, disputed mid-stay (keeps wifi/emergency info), or finished.
// 'checked_out' is deliberately excluded.
export const UNLOCKING_STATUSES = ['confirmed', 'checked_in', 'disputed', 'completed'];

@Injectable()
export class GuidebookService {
  constructor(
    @InjectRepository(GuidebookEntity) private readonly guidebooks: Repository<GuidebookEntity>,
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
  ) {}

  async getForHost(hostId: string, listingId: string): Promise<GuidebookSection[]> {
    await this.assertOwner(hostId, listingId);
    return this.sectionsOf(listingId);
  }

  async saveForHost(hostId: string, listingId: string, dto: UpdateGuidebookDto) {
    await this.assertOwner(hostId, listingId);
    const sections = dto.sections.map(({ title, body }) => ({ title, body }));
    await this.guidebooks.upsert(
      { listing_id: listingId, sections, updated_at: new Date() },
      ['listing_id'],
    );
    return sections;
  }

  async getForGuest(guestId: string, listingId: string): Promise<GuidebookSection[]> {
    const booking = await this.bookings.findOne({
      where: { listing_id: listingId, guest_id: guestId, status: In(UNLOCKING_STATUSES) },
      select: { id: true },
    });
    if (!booking) {
      throw new ForbiddenException('The guidebook opens once your booking is confirmed.');
    }
    return this.sectionsOf(listingId);
  }

  private async sectionsOf(listingId: string): Promise<GuidebookSection[]> {
    const row = await this.guidebooks.findOne({ where: { listing_id: listingId } });
    return row?.sections ?? [];
  }

  private async assertOwner(hostId: string, listingId: string) {
    const listing = await this.listings.findOne({
      where: { id: listingId },
      select: { id: true, host_id: true },
    });
    if (!listing) throw new NotFoundException('Listing not found.');
    if (listing.host_id !== hostId) throw new ForbiddenException('Not your listing.');
  }
}
