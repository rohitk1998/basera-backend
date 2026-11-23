import { Injectable, Logger } from '@nestjs/common';
import { InquiryEntity } from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import type { NotificationEvent } from '../notifications/notifications.types';
import { InquiryNoticeCore, NoticeKind, NoticeResult, NoticeStatus, SendOutcome3 } from './inquiry-notice-core.service';

/** Guest route that lists a guest's bookings (web: /settings?tab=bookings). */
export const GUEST_BOOKINGS_PATH = '/settings?tab=bookings';

@Injectable()
export class InquiryGuestNotices {
  private readonly logger = new Logger(InquiryGuestNotices.name);

  constructor(
    private readonly core: InquiryNoticeCore,
    private readonly notifications: NotificationsService,
  ) {}

  received(inq: InquiryEntity): Promise<NoticeResult> {
    return this.run(inq, 'received', 'inquiry.guest_received', 'stay_request_received', undefined);
  }

  requestSent(inq: InquiryEntity, booking: { id: string; reference: string }): Promise<NoticeResult> {
    void booking;
    return this.run(inq, 'request_sent', 'inquiry.request_sent', 'stay_request_sent_to_owner', GUEST_BOOKINGS_PATH);
  }

  datesUnavailable(inq: InquiryEntity, reason: 'admin' | 'dates_error' | 'sweep'): Promise<NoticeResult> {
    this.logger.log(`inquiry ${inq.id} dates unavailable notice (${reason})`);
    return this.run(inq, 'unavailable', 'inquiry.dates_unavailable', 'stay_dates_unavailable', null);
  }

  /** link: undefined = none, null = stays path for the town, string = that relative path. */
  private async run(
    inq: InquiryEntity,
    kind: NoticeKind,
    event: NotificationEvent,
    template: 'stay_request_received' | 'stay_request_sent_to_owner' | 'stay_dates_unavailable',
    link: string | null | undefined,
  ): Promise<NoticeResult> {
    const result: NoticeResult = { email: 'skipped', whatsapp: 'skipped' };
    try {
      const { propertyName, town } = await this.core.resolveProperty(inq);
      const checkIn = this.core.formatDate(inq.check_in);
      const checkOut = this.core.formatDate(inq.check_out);
      const relLink = link === null ? this.core.staysPath(town) : link;
      const data: Record<string, unknown> = {
        guestName: inq.guest_name,
        propertyName,
        listingTitle: propertyName,
        town,
        checkIn,
        checkOut,
        guests: inq.guests ?? 1,
        ref: inq.public_ref,
        ...(relLink ? { link: relLink } : {}),
      };
      // Anonymous guests have no account, so an in-app link would be useless: omit it for 'received'.
      if (!inq.guest_user_id && kind === 'received') delete data.link;

      const email = await this.core.once(inq, kind, 'guest', 'email', async (): Promise<SendOutcome3> => {
        if (inq.guest_user_id) {
          const res = await this.notifications.dispatch(event, inq.guest_user_id, data, {
            dedupeKey: `inquiry:${inq.id}:${kind}`,
          });
          const em = res.find((r) => r.channel === 'email');
          if (!em) return { status: 'skipped', reason: 'no_email_channel' };
          return { status: em.status, reason: em.reason ?? em.error };
        }
        const to = (inq.guest_email ?? '').trim();
        if (!to) return { status: 'skipped', reason: 'no_email' };
        const s = await this.notifications.sendEmailToAddress(to, event, data);
        return { status: s };
      });

      const base = this.core.appUrl();
      const params: Record<string, string> = {
        guest_name: inq.guest_name,
        property_name: propertyName,
        check_in_date: checkIn,
        check_out_date: checkOut,
      };
      if (template === 'stay_request_sent_to_owner') params.bookings_url = `${base}${GUEST_BOOKINGS_PATH}`;
      if (template === 'stay_dates_unavailable') params.stays_url = `${base}${this.core.staysPath(town)}`;

      const wa = await this.core.once(inq, kind, 'guest', 'whatsapp', () =>
        this.core.sendWhatsapp(inq, inq.guest_phone, template, params, `inquiry:${inq.id}:${kind}`),
      );

      result.email = email.status;
      result.whatsapp = wa.status;
      if (email.reason || wa.reason) {
        result.reasons = {
          ...(email.reason ? { email: email.reason } : {}),
          ...(wa.reason ? { whatsapp: wa.reason } : {}),
        };
      }
    } catch (e) {
      this.logger.warn(`guest notice ${kind} failed for inquiry ${inq.id}: ${(e as Error).message}`);
      const failed: NoticeStatus = 'failed';
      if (result.email === 'skipped') result.email = failed;
      if (result.whatsapp === 'skipped') result.whatsapp = failed;
    }
    return result;
  }
}
