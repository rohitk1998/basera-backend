import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IsNull, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import { NotificationLogEntity, ProfileEntity } from '../entities';
import { EMAIL_TEMPLATES } from './email-templates';
import { notificationCopy } from './notification-copy';
import { NotificationData, NotificationEvent } from './notifications.types';
import { MarkReadDto } from './dto/mark-read.dto';

const PAGE_SIZE = 10;

export interface NotificationListItem {
  id: string;
  event: string;
  channel: 'email' | 'push';
  status: 'sent' | 'failed' | 'skipped';
  title: string;
  body: string;
  link: string;
  sentAt: string;
  readAt: string | null;
}

interface DispatchResult {
  channel: string;
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}

/**
 * Ported from supabase/functions/notification-dispatcher/index.ts plus the
 * three app/api/notifications/* inbox routes. notify() used to fire-and-
 * forget an invocation of that Edge Function; here the same dispatch work
 * runs in-process (no edge function, no HTTP hop to ourselves) but stays
 * fire-and-forget from the caller's point of view — see notify() below.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private readonly appUrl: string;
  private readonly logoIconUrl: string;

  private fcmToken: string | null = null;
  private fcmTokenExpiry = 0;

  constructor(
    @InjectRepository(ProfileEntity)
    private readonly profiles: Repository<ProfileEntity>,
    @InjectRepository(NotificationLogEntity)
    private readonly notificationLog: Repository<NotificationLogEntity>,
    private readonly config: ConfigService,
  ) {
    this.appUrl = this.config.get<string>('APP_URL') ?? 'https://basera.in';
    // Public URL, not a data URI — Gmail (and most webmail clients) refuses
    // to render inline data:-URI images inside an email body; it only
    // displays images fetched from a real https:// URL, which it proxies
    // itself for privacy. Uploaded once to the `brand-assets` public bucket;
    // regenerate/re-upload if the source logo changes.
    this.logoIconUrl = `${this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL')}/storage/v1/object/public/brand-assets/email-icon.png`;
  }

  // ── In-app inbox (app/api/notifications/*) ───────────────────────────────

  /**
   * Cursor-paginated (not offset-based): offsets would skip or repeat rows
   * if a new notification lands between page fetches while the user is
   * scrolling. The cursor is (sentAt, id) — sentAt alone isn't unique,
   * since email+push from the same notify() call share a timestamp; id as
   * a tiebreaker keeps the page boundary stable across those ties.
   */
  async listForUser(
    userId: string,
    before?: string,
    beforeId?: string,
    locale?: string,
  ): Promise<{ notifications: NotificationListItem[]; nextCursor: { before: string; beforeId: string } | null }> {
    const qb = this.notificationLog
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .andWhere("n.channel = 'push'")
      .orderBy('n.sent_at', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .limit(PAGE_SIZE + 1); // fetch one extra to know if there's a next page

    if (before && beforeId) {
      // (sent_at, id) < (before, beforeId) in descending order.
      qb.andWhere('(n.sent_at < :before OR (n.sent_at = :before AND n.id < :beforeId))', {
        before,
        beforeId,
      });
    }

    const rows = await qb.getMany();

    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);

    const notifications: NotificationListItem[] = page.map((row) => {
      const payload = (row.payload as Record<string, unknown>) ?? {};
      const { title, body } = notificationCopy(row.event, payload, locale);
      return {
        id: row.id,
        event: row.event,
        channel: row.channel as 'email' | 'push',
        status: row.status as 'sent' | 'failed' | 'skipped',
        title,
        body,
        link: typeof payload.link === 'string' ? payload.link : '/',
        sentAt: (row.sent_at as unknown as Date).toISOString(),
        readAt: row.read_at ? (row.read_at as unknown as Date).toISOString() : null,
      };
    });

    const lastItem = notifications.at(-1);
    const nextCursor = hasMore && lastItem ? { before: lastItem.sentAt, beforeId: lastItem.id } : null;

    return { notifications, nextCursor };
  }

  async markRead(userId: string, dto: MarkReadDto): Promise<void> {
    const hasId = typeof dto.id === 'string';
    const hasAll = dto.all === true;

    if (hasId === hasAll || (!hasId && !hasAll)) {
      throw new BadRequestException('Pass either { id } or { all: true }');
    }

    const qb = this.notificationLog
      .createQueryBuilder()
      .update(NotificationLogEntity)
      .set({ read_at: new Date() })
      .where('user_id = :userId', { userId })
      .andWhere('read_at IS NULL');

    if (hasId) {
      qb.andWhere('id = :id', { id: dto.id });
    }

    await qb.execute();
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notificationLog.count({ where: { user_id: userId, read_at: IsNull(), channel: 'push' } });
  }

  /**
   * Every notify() caller sends a relative path ("/host/bookings") — the
   * right choice for push (webpush deep-links resolve against the app
   * itself) but broken as-is in an email, which has no origin to resolve
   * against. Absolute links pass through untouched.
   */
  private absoluteLink(link: unknown): string {
    const path = String(link ?? '/');
    return /^https?:\/\//.test(path) ? path : `${this.appUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /**
   * Fire-and-forget notification dispatch. Never awaited by the caller —
   * failures are caught and logged here rather than ever thrown back.
   */
  notify(event: NotificationEvent, userId: string, data: NotificationData): void {
    this.dispatch(event, userId, data).catch((err) => {
      this.logger.error(`[notify] dispatch failed for event=${event} userId=${userId}`, err);
    });
  }

  private async dispatch(event: NotificationEvent, userId: string, data: NotificationData): Promise<void> {
    const profile = await this.profiles.findOne({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        full_name: true,
        notif_email: true,
        notif_push: true,
        fcm_tokens: true,
        preferred_locale: true,
      },
    });

    if (!profile) {
      this.logger.warn(`[notify] profile not found for userId=${userId}, event=${event}`);
      return;
    }

    const allResults: DispatchResult[] = [];

    if (profile.notif_email && profile.email) {
      allResults.push(await this.sendEmail(profile.email, event, data));
    }

    if (profile.notif_push && profile.fcm_tokens?.length) {
      // Resolved from the recipient's own preferred_locale, not the
      // (possibly different) locale of whoever triggered this event — a
      // host's "listing is live" push should render in the host's
      // language, not the admin's who approved it.
      const { title, body } = notificationCopy(event, data as Record<string, unknown>, profile.preferred_locale ?? undefined);
      const { results: pushResults, staleTokens } = await this.sendPush(profile.fcm_tokens, title, body, data.link);
      allResults.push(...pushResults);

      if (staleTokens.length) {
        const remaining = profile.fcm_tokens.filter((t) => !staleTokens.includes(t));
        await this.profiles.update({ id: userId }, { fcm_tokens: remaining });
      }
    }

    if (allResults.length > 0) {
      const rows = allResults.map((r) =>
        this.notificationLog.create({
          user_id: userId,
          event,
          channel: r.channel,
          status: r.status,
          error: r.error ?? null,
        }),
      );
      rows.forEach((row) => {
        row.payload = data as Record<string, unknown>;
      });
      await this.notificationLog.save(rows);
    }
  }

  // ── Email delivery (Resend) ─────────────────────────────────────────────
  private async sendEmail(
    to: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const template = EMAIL_TEMPLATES[event];
    if (!template) return { channel: 'email', status: 'skipped' };

    const resendKey = this.config.get<string>('RESEND_API_KEY');
    if (!resendKey) return { channel: 'email', status: 'skipped' };

    const { subject, html } = template(data, {
      absoluteLink: (link) => this.absoluteLink(link),
      appUrl: this.appUrl,
      logoIconUrl: this.logoIconUrl,
    });

    // Falls back to Resend's shared test sender, which works with zero
    // setup, while basera.in (or any real domain) is unverified in the
    // Resend account. Set EMAIL_FROM once a real domain is verified — see
    // https://resend.com/domains.
    const from = this.config.get<string>('EMAIL_FROM') ?? 'Basera <onboarding@resend.dev>';

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, html }),
      });

      if (!res.ok) {
        const err = await res.text();
        return { channel: 'email', status: 'failed', error: err };
      }
      return { channel: 'email', status: 'sent' };
    } catch (e: any) {
      return { channel: 'email', status: 'failed', error: e.message };
    }
  }

  // ── FCM bearer token via service account ────────────────────────────────
  // Ported from getFcmBearerToken() (Deno SubtleCrypto RS256 signing) using
  // Node's jsonwebtoken package instead — same JWT claims, same
  // grant_type:jwt-bearer token exchange against Google's OAuth endpoint.
  private async getFcmBearerToken(): Promise<string | null> {
    if (this.fcmToken && Date.now() < this.fcmTokenExpiry) return this.fcmToken;

    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n');
    if (!clientEmail || !privateKey) return null;

    try {
      const now = Math.floor(Date.now() / 1000);
      const jwtAssertion = jwt.sign(
        {
          iss: clientEmail,
          sub: clientEmail,
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
        },
        privateKey,
        { algorithm: 'RS256' },
      );

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwtAssertion,
        }),
      });

      const tokenData = await tokenRes.json();
      this.fcmToken = tokenData.access_token ?? null;
      this.fcmTokenExpiry = Date.now() + (tokenData.expires_in ?? 3600) * 1000 - 60_000;
      return this.fcmToken;
    } catch (e) {
      this.logger.error('[FCM] Token fetch failed', e as Error);
      return null;
    }
  }

  // ── Push delivery (FCM v1 API) ───────────────────────────────────────────
  // A token FCM reports as UNREGISTERED/NotRegistered is permanently dead —
  // the device unregistered, the browser data was cleared, or the token
  // rotated. Without pruning these, profiles.fcm_tokens only ever grows and
  // every future push re-attempts (and re-fails) every dead entry forever.
  private isUnregistered(errBody: string): boolean {
    return errBody.includes('UNREGISTERED') || errBody.includes('NotRegistered');
  }

  private async sendPush(
    fcmTokens: string[],
    title: string,
    body: string,
    link: unknown,
  ): Promise<{ results: DispatchResult[]; staleTokens: string[] }> {
    if (!fcmTokens.length) return { results: [], staleTokens: [] };

    const bearerToken = await this.getFcmBearerToken();
    if (!bearerToken) return { results: [{ channel: 'push', status: 'skipped' }], staleTokens: [] };

    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const resolvedLink = this.absoluteLink(link);

    const results: DispatchResult[] = [];
    const staleTokens: string[] = [];

    for (const token of fcmTokens) {
      try {
        const res = await fetch(fcmUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title, body },
              webpush: { fcm_options: { link: resolvedLink } },
            },
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          if (this.isUnregistered(err)) staleTokens.push(token);
          results.push({ channel: 'push', status: 'failed', error: err });
        } else {
          results.push({ channel: 'push', status: 'sent' });
        }
      } catch (e: any) {
        results.push({ channel: 'push', status: 'failed', error: e.message });
      }
    }

    return { results, staleTokens };
  }
}
