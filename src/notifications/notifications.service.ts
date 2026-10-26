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
    this.logoIconUrl = `${this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL')}/storage/v1/object/public/brand-assets/email-icon.png`;
  }

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
      .limit(PAGE_SIZE + 1);

    if (before && beforeId) {
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

  private absoluteLink(link: unknown): string {
    const path = String(link ?? '/');
    return /^https?:\/\//.test(path) ? path : `${this.appUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

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
      const { title, body } = notificationCopy(event, data as Record<string, unknown>, profile.preferred_locale ?? undefined);
      const { results: pushResults, staleTokens } = await this.sendPush(profile.fcm_tokens, title, body, data.link);
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

  async sendEmailNow(to: string, event: string, data: Record<string, unknown>): Promise<void> {
    const result = await this.sendEmail(to, event, data);
    if (result.status === 'failed') {
      throw new Error(result.error ?? `Failed to send email for event=${event}`);
    }
    if (result.status === 'skipped') {
      throw new Error(`Email skipped for event=${event} — missing template or RESEND_API_KEY`);
    }
  }

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
      secure: Number(port) === 465,
      auth: { user, pass },
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
    const from = this.config.get<string>('SMTP_FROM') ?? `Basera <${this.config.get<string>('SMTP_USER')!}>`;

    try {
      await transporter.sendMail({ from, to, subject, html });
    } catch (e: any) {
      throw new Error(e?.message ?? 'Failed to send OTP email via SMTP');
    }
  }

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
