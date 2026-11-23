import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InquiryEntity, UserEntity } from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { InquiryNoticeCore, NoticeResult, NoticeStatus } from './inquiry-notice-core.service';

/**
 * Staff-side notice for a new stay request: email/in-app/push to the assignee (all admins only when nobody is
 * assigned, as before) plus one WhatsApp to ADMIN_WHATSAPP_NUMBER. Best-effort: never throws, each channel is
 * independent and deduped through InquiryNoticeCore.once. No owner phone and no Google content in any payload.
 */
@Injectable()
export class InquiryAdminNotices {
  private readonly logger = new Logger(InquiryAdminNotices.name);

  constructor(
    private readonly core: InquiryNoticeCore,
    private readonly notifications: NotificationsService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
  ) {}

  async newRequest(inq: InquiryEntity, assigneeId: string | null): Promise<NoticeResult> {
    const fail = (e: unknown): { status: NoticeStatus; reason?: string } => {
      this.logger.warn(`admin notice failed for inquiry ${inq.id}: ${(e as Error)?.message ?? e}`);
      return { status: 'failed', reason: 'error' };
    };
    let property = { propertyName: 'a listed stay', town: '' };
    try {
      property = await this.core.resolveProperty(inq);
    } catch (e) {
      this.logger.warn(`resolveProperty failed for inquiry ${inq.id}: ${(e as Error)?.message ?? e}`);
    }
    const propertyName = property.propertyName || inq.destination || 'a listed stay';
    const checkIn = inq.check_in ? this.core.formatDate(inq.check_in) : '';
    const checkOut = inq.check_out ? this.core.formatDate(inq.check_out) : '';

    const email = await this.core
      .once(inq, 'admin_new', 'admin', 'email', async () => {
        const recipients = await this.recipients(assigneeId);
        if (!recipients.length) return { status: 'skipped' as const, reason: 'no_admin' };
        const data = {
          guestName: inq.guest_name,
          propertyName,
          listingTitle: propertyName,
          town: property.town,
          checkIn,
          checkOut,
          guests: inq.guests,
          ref: inq.public_ref,
          link: '/admin',
        };
        let sent = false;
        for (const id of recipients) {
          const results = await this.notifications.dispatch('inquiry.new', id, data, {
            dedupeKey: `inquiry:${inq.id}:admin`,
          });
          if (results.some((r) => r.channel === 'email' && r.status === 'sent') || results.some((r) => r.status === 'sent')) {
            sent = true;
          }
        }
        return sent ? { status: 'sent' as const } : { status: 'skipped' as const, reason: 'not_delivered' };
      })
      .catch(fail);

    const whatsapp = await this.core
      .once(inq, 'admin_new', 'admin', 'whatsapp', async () => {
        const to = this.core.adminWhatsappNumber();
        if (!to) {
          this.logger.log(`admin WhatsApp not configured (ADMIN_WHATSAPP_NUMBER missing) for inquiry ${inq.id}`);
          return { status: 'skipped' as const, reason: 'not_configured' };
        }
        const adminName = await this.adminName(assigneeId);
        return this.core.sendWhatsapp(
          inq,
          to,
          'stay_request_admin_alert',
          {
            admin_name: adminName,
            request_ref: inq.public_ref,
            guest_name: inq.guest_name,
            property_name: propertyName,
            check_in_date: checkIn,
            check_out_date: checkOut,
          },
          'staff:primary-admin',
        );
      })
      .catch(fail);

    const reasons: { email?: string; whatsapp?: string } = {};
    if (email.reason) reasons.email = email.reason;
    if (whatsapp.reason) reasons.whatsapp = whatsapp.reason;
    return { email: email.status, whatsapp: whatsapp.status, ...(Object.keys(reasons).length ? { reasons } : {}) };
  }

  /** Assignee only; every admin only when nobody is assigned (same fallback as the old notifyOps). */
  private async recipients(assigneeId: string | null): Promise<string[]> {
    if (assigneeId) return [assigneeId];
    const admins = await this.users.find({ where: { role: 'admin' }, select: { id: true }, take: 50 });
    return admins.map((a) => a.id);
  }

  private async adminName(assigneeId: string | null): Promise<string> {
    if (!assigneeId) return 'Admin';
    try {
      const u = await this.users.findOne({ where: { id: assigneeId }, select: { id: true, full_name: true } });
      const first = (u?.full_name ?? '').trim().split(/\s+/)[0];
      return first || 'Admin';
    } catch {
      return 'Admin';
    }
  }
}
