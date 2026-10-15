import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IsNull, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';
import * as nodemailer from 'nodemailer';
import { NotificationLogEntity, UserEntity } from '../entities';
import { EMAIL_TEMPLATES } from './email-templates';
import { notificationCopy } from './notification-copy';
import { describeFcmError, parseFcmError } from './fcm-errors';
import { NotificationData, NotificationEvent } from './notifications.types';
import { MarkReadDto } from './dto/mark-read.dto';

const PAGE_SIZE = 10;

/** Guest-facing request outcomes go out over the Gmail SMTP transport: Resend's
 *  shared sender only delivers to Resend-owned test addresses, so a real
 *  guest's inbox never received these. */
const SMTP_EMAIL_EVENTS = new Set([
  'user.welcome',
  'booking.confirmed',
  'booking.declined',
  'booking.payment_receipt',
  'booking.checkin_confirmed',
  'booking.requested',
  'booking.payment_held',
  'booking.checked_in',
  'booking.disputed',
  'dispute.raised_confirmation',
  'dispute.offer_received',
  'dispute.offer_accepted',
  'dispute.offer_rejected',
  'dispute.escalated',
  'dispute.resolved',
  'dispute.appeal_raised',
]);

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
    @InjectRepository(UserEntity)
    private readonly profiles: Repository<UserEntity>,
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

    // Always record an in-app notification inbox entry so notifications appear
    // in the UI /inbox regardless of whether external FCM push tokens are registered.
    // Saved before any email/push network call: those can take seconds (SMTP),
    // and the bell badge / inbox read this row, so it must not wait on them.
    await this.notificationLog.save(
      this.notificationLog.create({
        user_id: userId,
        event,
        channel: 'push',
        status: 'sent',
        error: null,
        payload: data as Record<string, unknown>,
      }),
    );

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
      // We already logged the base inbox push entry above; if sendPush had results, we can record them or let staleTokens prune.
      if (staleTokens.length) {
        await this.pruneTokens(userId, staleTokens);
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

  /**
   * Awaited email send for the one caller that must see a failure rather
   * than have it swallowed: AuthController.sendEmailOtp. Every other email
   * in this app goes through notify()'s fire-and-forget dispatch(), where a
   * failed send is merely logged — fine for a "welcome" or "dispute
   * escalated" email, not fine for the OTP itself, since the user has no
   * other way to know the code never arrived. Reuses the same EMAIL_TEMPLATES
   * lookup and sendEmail() plumbing as every other template; just doesn't
   * swallow the result.
   */
  async sendEmailNow(to: string, event: string, data: Record<string, unknown>): Promise<void> {
    const result = await this.sendEmail(to, event, data);
    if (result.status === 'failed') {
      throw new Error(result.error ?? `Failed to send email for event=${event}`);
    }
    if (result.status === 'skipped') {
      throw new Error(`Email skipped for event=${event} — missing template or RESEND_API_KEY`);
    }
  }

  /**
   * OTP-only delivery path, via Gmail SMTP instead of Resend. Resend's
   * shared onboarding@resend.dev sender only delivers to a handful of
   * Resend-owned test addresses until a real domain is verified on the
   * account — fine for the "welcome"/dispute emails during development
   * (those go to whoever's testing), but useless for an OTP code that has
   * to reach an arbitrary real inbox right now. Kept entirely separate from
   * sendEmailNow/sendEmail above: same EMAIL_TEMPLATES['auth.otp_code']
   * template, different transport, and this is the only thing SMTP_* is
   * used for — every other email in this app still goes through Resend.
   */
  private smtpTransporter: nodemailer.Transporter | null = null;

  private getSmtpTransporter(): nodemailer.Transporter {
    if (this.smtpTransporter) return this.smtpTransporter;

    const host = this.config.get<string>('SMTP_HOST');
    const port = this.config.get<string>('SMTP_PORT');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    if (!host || !port || !user || !pass) {
      throw new Error('SMTP is not configured — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.');
    }

    this.smtpTransporter = nodemailer.createTransport({
      host,
      port: Number(port),
      // 587 is STARTTLS (secure: false, upgraded after connect), not the
      // implicit-TLS 465 that Gmail also serves — the two are not
      // interchangeable with the same `secure` flag.
      secure: Number(port) === 465,
      auth: { user, pass },
      // Keep the authenticated connection open and reuse it, instead of a
      // fresh TCP + TLS + AUTH handshake to Gmail on every code (most of the
      // multi-second send time).
      pool: true,
    });
    return this.smtpTransporter;
  }

  async sendEmailOtpViaSmtp(to: string, data: Record<string, unknown>): Promise<void> {
    const template = EMAIL_TEMPLATES['auth.otp_code'];
    const { subject, html } = template(data, {
      absoluteLink: (link) => this.absoluteLink(link),
      appUrl: this.appUrl,
      logoIconUrl: this.logoIconUrl,
    });

    const transporter = this.getSmtpTransporter();
    // SMTP_FROM overrides the visible sender (e.g. "Basera <no-reply@basera.in>");
    // the SMTP server must be allowed to send as that address. Defaults to the
    // authenticated account, as before.
    const from = this.config.get<string>('SMTP_FROM') ?? `Basera <${this.config.get<string>('SMTP_USER')!}>`;

    try {
      await transporter.sendMail({ from, to, subject, html });
    } catch (e: any) {
      throw new Error(e?.message ?? 'Failed to send OTP email via SMTP');
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

    const { subject, html } = template(data, {
      absoluteLink: (link) => this.absoluteLink(link),
      appUrl: this.appUrl,
      logoIconUrl: this.logoIconUrl,
    });

    if (SMTP_EMAIL_EVENTS.has(event)) {
      try {
        const from = this.config.get<string>('SMTP_FROM') ?? `Basera <${this.config.get<string>('SMTP_USER')}>`;
        await this.getSmtpTransporter().sendMail({ from, to, subject, html });
        return { channel: 'email', status: 'sent' };
      } catch (e: any) {
        this.logger.error(`[email] SMTP send failed for event=${event}: ${e?.message ?? e}`);
        return { channel: 'email', status: 'failed', error: e?.message ?? String(e) };
      }
    }

    const resendKey = this.config.get<string>('RESEND_API_KEY');
    if (!resendKey) return { channel: 'email', status: 'skipped' };

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
      if (!tokenRes.ok || !tokenData.access_token) {
        // Google's OAuth error is { error, error_description } — safe to log, it
        // never echoes the assertion or key.
        this.logger.warn(
          `[FCM] OAuth token exchange failed: http=${tokenRes.status} error=${tokenData?.error ?? 'n/a'} description="${String(tokenData?.error_description ?? '').slice(0, 200)}"`,
        );
      }
      this.fcmToken = tokenData.access_token ?? null;
      this.fcmTokenExpiry = Date.now() + (tokenData.expires_in ?? 3600) * 1000 - 60_000;
      return this.fcmToken;
    } catch (e) {
      this.logger.error(`[FCM] Token fetch failed: ${(e as Error)?.name}: ${(e as Error)?.message}`);
      return null;
    }
  }

  // ── Push delivery (FCM v1 API) ───────────────────────────────────────────
  // A token FCM reports as UNREGISTERED/NotRegistered is permanently dead —
  // the device unregistered, the browser data was cleared, or the token
  // rotated. Without pruning these, profiles.fcm_tokens only ever grows and
  // every future push re-attempts (and re-fails) every dead entry forever.
  // Re-reads the row so a token the browser registered while this push was in
  // flight is not wiped out by a stale in-memory copy of the array.
  async pruneTokens(userId: string, staleTokens: string[]): Promise<void> {
    if (!staleTokens.length) return;
    try {
      const row = await this.profiles.findOne({ where: { id: userId }, select: { id: true, fcm_tokens: true } });
      const current = row?.fcm_tokens ?? [];
      const remaining = current.filter((t) => !staleTokens.includes(t));
      if (remaining.length !== current.length) {
        await this.profiles.update({ id: userId }, { fcm_tokens: remaining });
        this.logger.log(`[FCM] Pruned ${current.length - remaining.length} dead push token(s) for user ${userId}`);
      }
    } catch (e) {
      this.logger.warn(`[FCM] Pruning dead push tokens failed: ${(e as Error)?.name}: ${(e as Error)?.message}`);
    }
  }

  private async sendPush(
    fcmTokens: string[],
    title: string,
    body: string,
    link: unknown,
  ): Promise<{ results: DispatchResult[]; staleTokens: string[] }> {
    if (!fcmTokens.length) return { results: [], staleTokens: [] };

    const bearerToken = await this.getFcmBearerToken();
    if (!bearerToken) {
      this.logger.warn('[FCM] Push skipped: no bearer token (FIREBASE_CLIENT_EMAIL/PRIVATE_KEY missing or OAuth failed)');
      return { results: [{ channel: 'push', status: 'skipped' }], staleTokens: [] };
    }

    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const resolvedLink = this.absoluteLink(link);

    // One notification can carry many devices per recipient (fcm_tokens
    // grows per device, never per notification) — sequential awaits here
    // meant total latency scaled linearly with device count instead of
    // being bounded by the slowest single FCM call. Each token's outcome
    // is independent (one device's failure/staleness must never affect
    // another's), so Promise.all + per-token try/catch keeps that
    // isolation while sending every request concurrently.
    const perToken = await Promise.all(
      fcmTokens.map(async (token): Promise<{ result: DispatchResult; staleToken: string | null }> => {
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
            const info = parseFcmError(res.status, err);
            this.logger.warn(`[FCM] Push send failed: ${describeFcmError(info)}${info.tokenDead ? ' (token will be pruned)' : ''}`);
            // A 401 means our cached bearer is bad; drop it so the next send re-authenticates.
            if (res.status === 401) this.fcmToken = null;
            return {
              result: { channel: 'push', status: 'failed', error: `${info.status || res.status} ${info.errorCode}`.trim() },
              staleToken: info.tokenDead ? token : null,
            };
          }
          return { result: { channel: 'push', status: 'sent' }, staleToken: null };
        } catch (e: any) {
          this.logger.warn(`[FCM] Push send threw: ${e?.name}: ${e?.message}`);
          return { result: { channel: 'push', status: 'failed', error: e.message }, staleToken: null };
        }
      }),
    );

    return {
      results: perToken.map((r) => r.result),
      staleTokens: perToken.map((r) => r.staleToken).filter((t): t is string => t !== null),
    };
  }
}
