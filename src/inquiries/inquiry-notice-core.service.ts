import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InquiryEntity, InquiryEventEntity, ListingEntity } from '../entities';
import { ConsentService } from '../notifications/consent.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import type { WhatsappTemplateName } from '../whatsapp/whatsapp-templates';

export type NoticeStatus = 'sent' | 'skipped' | 'failed' | 'duplicate';
export interface NoticeResult {
  email: NoticeStatus;
  whatsapp: NoticeStatus;
  reasons?: { email?: string; whatsapp?: string };
}
export type NoticeKind = 'received' | 'admin_new' | 'request_sent' | 'unavailable';
export type NoticeTo = 'guest' | 'admin';
export type NoticeChannel = 'email' | 'whatsapp';
export type SendOutcome3 = { status: 'sent' | 'skipped' | 'failed'; reason?: string };

export const E164 = /^\+[1-9]\d{7,14}$/;
export const DEFAULT_APP_URL = 'https://www.rhenbasera.online';

function maskRecipient(v: string | null | undefined): string {
  if (!v) return '-';
  const s = String(v);
  return s.length <= 4 ? '***' : `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** Shared helpers for inquiry notices: dedupe via inquiry_events, WhatsApp consent, safe property text. Never throws. */
@Injectable()
export class InquiryNoticeCore {
  private readonly logger = new Logger(InquiryNoticeCore.name);

  constructor(
    @InjectRepository(InquiryEventEntity) private readonly events: Repository<InquiryEventEntity>,
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    private readonly whatsapp: WhatsappService,
    private readonly consent: ConsentService,
    private readonly config: ConfigService,
  ) {}

  /** Stored columns only (never Google content). */
  async resolveProperty(inq: InquiryEntity): Promise<{ propertyName: string; town: string }> {
    const listingId = inq.candidate_listing_id ?? inq.target_listing_id;
    let title = '';
    let town = '';
    if (listingId) {
      try {
        const row = await this.listings.findOne({
          where: { id: listingId },
          select: { id: true, draft_data: true, disc_district: true, discovery_destination: true },
        });
        const d = (row?.draft_data as Record<string, any>) ?? {};
        const p = d.property_details || d.property || d.basics || {};
        title = String(p.title ?? '').trim();
        town = (row?.disc_district || row?.discovery_destination || '').trim();
      } catch (e) {
        this.logger.warn(`resolveProperty failed for inquiry ${inq.id}: ${(e as Error).message}`);
      }
    }
    if (!town) town = (inq.destination ?? '').trim();
    return { propertyName: title || 'the property', town };
  }

  async once(
    inq: InquiryEntity,
    kind: NoticeKind,
    to: NoticeTo,
    channel: NoticeChannel,
    send: () => Promise<SendOutcome3>,
  ): Promise<{ status: NoticeStatus; reason?: string }> {
    try {
      const prior = await this.events
        .createQueryBuilder('e')
        .where('e.inquiry_id = :id', { id: inq.id })
        .andWhere("e.type = 'notice'")
        .andWhere("e.meta->>'kind' = :kind", { kind })
        .andWhere("e.meta->>'to' = :to", { to })
        .andWhere("e.meta->>'channel' = :channel", { channel })
        .getCount();
      if (prior > 0) return { status: 'duplicate' };
    } catch (e) {
      this.logger.warn(`notice dedupe lookup failed (${kind}/${to}/${channel}) inquiry ${inq.id}: ${(e as Error).message}`);
    }

    let out: SendOutcome3;
    try {
      out = await send();
    } catch (e) {
      out = { status: 'failed', reason: (e as Error).message?.slice(0, 200) || 'error' };
    }

    try {
      await this.events.save(
        this.events.create({
          inquiry_id: inq.id,
          type: 'notice',
          from_state: null,
          to_state: null,
          actor_id: null,
          meta: { kind, to, channel, status: out.status, ...(out.reason ? { reason: out.reason } : {}) },
        }),
      );
    } catch (e) {
      this.logger.warn(`notice event write failed (${kind}/${to}/${channel}) inquiry ${inq.id}: ${(e as Error).message}`);
    }
    const msg = `inquiry ${inq.id} notice ${kind} ${to} ${channel}: ${out.status}${out.reason ? ` (${out.reason})` : ''}`;
    if (out.status === 'failed') this.logger.warn(msg);
    else this.logger.log(msg);
    return { status: out.status, reason: out.reason };
  }

  async sendWhatsapp(
    inq: InquiryEntity,
    toPhone: string | null | undefined,
    template: WhatsappTemplateName,
    params: Record<string, string>,
    grantSource: string,
  ): Promise<SendOutcome3> {
    const phone = (toPhone ?? '').trim();
    if (!phone || !E164.test(phone)) return { status: 'skipped', reason: 'no_phone' };
    try {
      await this.ensureConsent(phone, grantSource);
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) {
        clean[k] = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
      }
      const res = await this.whatsapp.sendTemplate({
        to: phone,
        template,
        params: clean,
        relatedType: 'inquiry',
        relatedId: inq.id,
      });
      if (res.status === 'blocked') {
        if (/not configured/i.test(res.reason)) {
          this.logger.log(`WhatsApp not configured: ${template} skipped for inquiry ${inq.id} (${maskRecipient(phone)})`);
        }
        return { status: 'skipped', reason: res.reason };
      }
      if (res.dryRun) return { status: 'skipped', reason: 'dry_run' };
      return { status: 'sent' };
    } catch (e) {
      return { status: 'failed', reason: (e as Error).message?.slice(0, 200) || 'error' };
    }
  }

  /** Opt-in on request; a revoked (STOP) number is never re-granted. Errors swallowed. */
  async ensureConsent(phone: string, source: string): Promise<void> {
    try {
      const row = await this.consent.get('phone', phone, 'whatsapp');
      const status = row?.consent_status;
      if (status === 'revoked' || status === 'granted') return;
      await this.consent.set('phone', phone, 'whatsapp', 'granted', source);
    } catch (e) {
      this.logger.warn(`ensureConsent failed (${maskRecipient(phone)}): ${(e as Error).message}`);
    }
  }

  formatDate(d: string | Date | null | undefined): string {
    if (!d) return '';
    const date = typeof d === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d) : d;
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  staysPath(town: string): string {
    return town ? `/stays?q=${encodeURIComponent(town)}` : '/stays';
  }

  appUrl(): string {
    const raw = String(this.config.get('APP_URL') ?? '').trim() || DEFAULT_APP_URL;
    return raw.replace(/\/+$/, '');
  }

  adminWhatsappNumber(): string | null {
    const v = String(this.config.get('ADMIN_WHATSAPP_NUMBER') ?? '').trim();
    return v || null;
  }

  async grantGuestConsentOnCreate(inq: InquiryEntity): Promise<void> {
    try {
      await this.ensureConsent(inq.guest_phone, `inquiry:${inq.id}:request`);
    } catch {
      /* best-effort */
    }
  }
}
