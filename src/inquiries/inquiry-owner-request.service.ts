import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { BookingEntity, InquiryEntity, InquiryEventEntity, InquiryMessageEntity, ListingEntity } from '../entities';
import { BookingsService, BOOKING_ERROR_CODES } from '../bookings/bookings.service';
import type { CreateBookingDto } from '../bookings/dto/create-booking.dto';
import { candidateReadiness } from './candidate-readiness';
import { InquiryGuestNotices } from './inquiry-guest-notices.service';
import type { NoticeResult } from './inquiry-notice-core.service';
import { TERMINAL_STATES, canTransition } from './inquiry.util';

export interface SendToOwnerResult {
  id: string;
  state: 'CONVERTED' | 'DECLINED';
  changed: boolean;
  bookingId?: string;
  bookingReference?: string;
  autoUnavailable?: boolean;
  reason?: string;
  notices?: NoticeResult;
}

const MAX_NIGHTS = 730;
const DAY_MS = 86_400_000;

const ymd = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS;

/**
 * Admin action "Owner onboarded: send request to owner". The ONLY path from an inquiry to the bookings service.
 * It creates a normal booking request through BookingsService.create (overlap lock, price snapshot, all rules)
 * with a per-inquiry idempotency key, so a double click or a retry after a crash never makes two bookings.
 */
@Injectable()
export class InquiryOwnerRequestService {
  private readonly logger = new Logger(InquiryOwnerRequestService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly bookings: BookingsService,
    private readonly guestNotices: InquiryGuestNotices,
  ) {}

  async sendToOwner(inquiryId: string, actorId: string, note?: string): Promise<SendToOwnerResult> {
    const text = note?.trim() || '';
    type Outcome =
      | { kind: 'noop'; result: SendToOwnerResult }
      | { kind: 'sent'; inq: InquiryEntity; booking: { id: string; reference: string }; replayed: boolean }
      | { kind: 'declined'; inq: InquiryEntity; reason: string };

    const outcome: Outcome = await this.dataSource.transaction(async (manager) => {
      const inq = await manager
        .getRepository(InquiryEntity)
        .findOne({ where: { id: inquiryId }, lock: { mode: 'pessimistic_write' } });
      if (!inq) throw new ConflictException({ code: 'NOT_READY', message: 'Inquiry not found.' });

      if (inq.state === 'CONVERTED' && inq.converted_booking_id) {
        const b = await manager
          .getRepository(BookingEntity)
          .findOne({ where: { id: inq.converted_booking_id }, select: { id: true, reference: true } })
          .catch(() => null);
        return {
          kind: 'noop',
          result: {
            id: inq.id,
            state: 'CONVERTED',
            changed: false,
            bookingId: inq.converted_booking_id,
            bookingReference: (b as any)?.reference ?? undefined,
          },
        };
      }
      if (TERMINAL_STATES.includes(inq.state)) {
        throw new ConflictException({ code: 'ALREADY_CLOSED', message: `This request is already ${inq.state}.` });
      }
      if (!canTransition(inq.state, 'CONVERTED')) {
        throw new ConflictException({ code: 'CANNOT_SEND', message: `Cannot send a request in state ${inq.state}.` });
      }

      const listing = inq.candidate_listing_id
        ? await manager.getRepository(ListingEntity).findOne({
            where: { id: inq.candidate_listing_id },
            select: {
              id: true,
              status: true,
              is_discovered: true,
              host_id: true,
              booking_eligible: true,
              claimed_at: true,
              disc_district: true,
              discovery_destination: true,
            },
          })
        : null;
      const ready = candidateReadiness(listing, inq);
      if (!ready.ok) throw new ConflictException({ code: 'NOT_READY', message: ready.reason });

      const moveIn = ymd(inq.check_in as string);
      const moveOut = ymd(inq.check_out as string);
      const nights = Math.min(MAX_NIGHTS, Math.max(1, Math.round(dayNum(moveOut) - dayNum(moveIn)) || 1));
      const dto: CreateBookingDto = {
        listingId: inq.candidate_listing_id as string,
        moveIn,
        moveOut,
        days: nights,
        adults: Math.max(1, inq.guests ?? 1),
        children: 0,
        infants: 0,
        pets: 0,
        paymentMethod: 'upi',
        role: 'guest',
      } as CreateBookingDto;

      let result: { id: string; reference: string; replayed?: boolean };
      try {
        result = (await this.bookings.create(inq.guest_user_id as string, dto, `inquiry:${inq.id}`, {
          source: 'inquiry',
        })) as any;
      } catch (e: any) {
        if (!(e instanceof HttpException)) throw e;
        const status = e.getStatus();
        const body: any = e.getResponse();
        const code = typeof body === 'object' ? body?.code : undefined;
        const message = typeof body === 'object' ? String(body?.message ?? e.message) : String(body);
        if (code === BOOKING_ERROR_CODES.DATES_BUSY || code === BOOKING_ERROR_CODES.DATES_PAST) {
          await this.writeDecline(manager, inq, actorId, text, message);
          return { kind: 'declined', inq, reason: message };
        }
        if (code === BOOKING_ERROR_CODES.OPEN_REQUEST) {
          throw new ConflictException({ code: 'GUEST_HAS_OPEN_REQUEST', message });
        }
        if (status >= 400 && status < 500) throw new ConflictException({ code: 'CANNOT_SEND', message });
        throw e;
      }

      const from = inq.state;
      inq.state = 'CONVERTED';
      inq.converted_booking_id = result.id;
      inq.target_listing_id = inq.candidate_listing_id;
      if (!inq.first_response_at) inq.first_response_at = new Date();
      await manager.getRepository(InquiryEntity).save(inq);
      await this.writeNote(manager, inq.id, actorId, text);
      await manager.getRepository(InquiryEventEntity).save(
        manager.getRepository(InquiryEventEntity).create({
          inquiry_id: inq.id,
          type: 'state_changed',
          from_state: from,
          to_state: 'CONVERTED',
          actor_id: actorId,
          meta: {
            action: 'send_to_owner',
            from,
            to: 'CONVERTED',
            ...(text ? { note: true } : {}),
            bookingId: result.id,
            reference: result.reference,
            ...(result.replayed ? { replayed: true } : {}),
          },
        }),
      );
      return { kind: 'sent', inq, booking: { id: result.id, reference: result.reference }, replayed: !!result.replayed };
    });

    if (outcome.kind === 'noop') return outcome.result;

    if (outcome.kind === 'declined') {
      const notices = await this.safeNotice(() => this.guestNotices.datesUnavailable(outcome.inq, 'dates_error'));
      return {
        id: outcome.inq.id,
        state: 'DECLINED',
        changed: true,
        autoUnavailable: true,
        reason: outcome.reason,
        notices,
      };
    }

    let notices: NoticeResult | undefined;
    if (!outcome.replayed) {
      notices = await this.safeNotice(() => this.guestNotices.requestSent(outcome.inq, outcome.booking));
    }
    return {
      id: outcome.inq.id,
      state: 'CONVERTED',
      changed: true,
      bookingId: outcome.booking.id,
      bookingReference: outcome.booking.reference,
      ...(notices ? { notices } : {}),
    };
  }

  private async writeDecline(manager: EntityManager, inq: InquiryEntity, actorId: string, note: string, reason: string) {
    const from = inq.state;
    inq.state = 'DECLINED';
    if (!inq.first_response_at) inq.first_response_at = new Date();
    await manager.getRepository(InquiryEntity).save(inq);
    await this.writeNote(manager, inq.id, actorId, note);
    await manager.getRepository(InquiryEventEntity).save(
      manager.getRepository(InquiryEventEntity).create({
        inquiry_id: inq.id,
        type: 'state_changed',
        from_state: from,
        to_state: 'DECLINED',
        actor_id: actorId,
        meta: { action: 'dates_unavailable', from, to: 'DECLINED', auto: true, reason, ...(note ? { note: true } : {}) },
      }),
    );
  }

  private async writeNote(manager: EntityManager, inquiryId: string, actorId: string, note: string) {
    if (!note) return;
    const repo = manager.getRepository(InquiryMessageEntity);
    await repo.save(repo.create({ inquiry_id: inquiryId, direction: 'internal', channel: 'internal', body: note, actor_id: actorId }));
  }

  /** Notices are best-effort: a failure here must never undo or fail the committed action. */
  private async safeNotice(fn: () => Promise<NoticeResult>): Promise<NoticeResult | undefined> {
    try {
      return await fn();
    } catch (e: any) {
      this.logger.warn(`inquiry notice failed: ${e?.message ?? e}`);
      return undefined;
    }
  }
}
