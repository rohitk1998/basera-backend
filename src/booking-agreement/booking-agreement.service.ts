import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BookingEntity, ListingEntity, UserEntity } from '../entities';
import { BookingAgreementAckEntity } from './booking-agreement-ack.entity';
import {
  AGREEMENT_VERSION,
  firstNameOf,
  hashAgreement,
  renderAgreement,
} from './agreement-renderer';

const CLOSED_STATUSES = ['declined', 'cancelled', 'expired'];

type PartyState = { acknowledged: boolean; acknowledgedAt: Date | null };

export type AgreementView = {
  bookingId: string;
  text: string;
  version: string;
  hash: string;
  guest: PartyState;
  host: PartyState;
  /** Whether the viewer is the guest or the host. */
  viewerRole: 'guest' | 'host';
};

@Injectable()
export class BookingAgreementService {
  constructor(
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(BookingAgreementAckEntity)
    private readonly acks: Repository<BookingAgreementAckEntity>,
  ) {}

  async get(userId: string, bookingId: string): Promise<AgreementView> {
    const { view } = await this.build(userId, bookingId);
    return view;
  }

  /** Idempotent: re-acknowledging the same text keeps the original timestamp and ip. */
  async acknowledge(userId: string, bookingId: string, ip: string | undefined): Promise<AgreementView> {
    const { booking, view } = await this.build(userId, bookingId);
    if (CLOSED_STATUSES.includes(booking.status)) {
      throw new ConflictException(`Cannot acknowledge an agreement for a ${booking.status} booking`);
    }
    const existing = await this.acks.findOne({ where: { booking_id: bookingId, user_id: userId } });
    if (existing?.text_hash === view.hash) return view;

    if (existing) {
      await this.acks.update(
        { id: existing.id },
        { version: view.version, text_hash: view.hash, acknowledged_at: new Date(), ip: ip ?? null },
      );
    } else {
      await this.acks.upsert(
        {
          booking_id: bookingId,
          user_id: userId,
          version: view.version,
          text_hash: view.hash,
          acknowledged_at: new Date(),
          ip: ip ?? null,
        },
        ['booking_id', 'user_id'],
      );
    }
    return (await this.build(userId, bookingId)).view;
  }

  private async build(userId: string, bookingId: string) {
    const booking = await this.bookings.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('Forbidden');
    }

    const [listing, guest, host, acks] = await Promise.all([
      this.listings.findOne({ where: { id: booking.listing_id }, select: { id: true, draft_data: true } }),
      this.users.findOne({ where: { id: booking.guest_id }, select: { id: true, full_name: true } }),
      this.users.findOne({ where: { id: booking.host_id }, select: { id: true, full_name: true } }),
      this.acks.find({ where: { booking_id: bookingId } }),
    ]);

    const draft = (listing?.draft_data ?? {}) as Record<string, any>;
    const prop = (draft.property_details ?? draft.property ?? draft.basics ?? {}) as Record<string, any>;
    const text = renderAgreement({
      listingTitle: prop.title || 'the listing',
      hostFirstName: firstNameOf(host?.full_name, 'the host'),
      guestFirstName: firstNameOf(guest?.full_name, 'the guest'),
      moveIn: booking.move_in,
      moveOut: booking.move_out,
      months: booking.months,
      monthlyRent: booking.monthly_rent,
      deposit: booking.deposit,
      dueAtMoveIn: booking.due_at_move_in,
      checkIn: prop.checkIn || null,
      checkOut: prop.checkOut || null,
      pets: typeof prop.pets === 'boolean' ? prop.pets : null,
      smoking: typeof prop.smoking === 'boolean' ? prop.smoking : null,
      quietHours: prop.quietHours || null,
      cancellationPolicy: prop.cancellation || null,
    });
    const hash = hashAgreement(text);

    const stateFor = (uid: string): PartyState => {
      const row = acks.find((a) => a.user_id === uid && a.text_hash === hash);
      return { acknowledged: !!row, acknowledgedAt: row?.acknowledged_at ?? null };
    };

    const view: AgreementView = {
      bookingId,
      text,
      version: AGREEMENT_VERSION,
      hash,
      guest: stateFor(booking.guest_id),
      host: stateFor(booking.host_id),
      viewerRole: booking.guest_id === userId ? 'guest' : 'host',
    };
    return { booking, view };
  }
}
