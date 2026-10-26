import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_BASE_URL = 'https://verification.didit.me';
const DEFAULT_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_SKEW_SECONDS = 300;

export const DIDIT_UNAVAILABLE = 'Verification service is temporarily unavailable. Please try again.';

export function canonicalJson(value: unknown): string {
  const normalise = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalise);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = normalise((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(normalise(value));
}

export function signWebhookBody(body: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(body), 'utf8').digest('hex');
}

export type WebhookCheck = 'ok' | 'not_configured' | 'bad_signature' | 'stale';

export interface DiditSession {
  sessionId: string;
  url: string;
}

@Injectable()
export class DiditService {
  private readonly logger = new Logger(DiditService.name);
  timeoutMs = DEFAULT_TIMEOUT_MS;

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string {
    return (this.config.get<string>('DIDIT_BASE_URL') || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  async createSession(userId: string): Promise<DiditSession> {
    const apiKey = this.config.get<string>('DIDIT_API_KEY');
    const workflowId = this.config.get<string>('DIDIT_WORKFLOW_ID');
    if (!apiKey || !workflowId) {
      this.logger.error('[Didit] session: DIDIT_API_KEY or DIDIT_WORKFLOW_ID is not set');
      throw new ServiceUnavailableException(DIDIT_UNAVAILABLE);
    }
    const payload: Record<string, unknown> = {
      workflow_id: workflowId,
      vendor_data: userId,
      metadata: { source: 'basera' },
      language: 'en',
    };
    const callback = this.config.get<string>('DIDIT_CALLBACK_URL');
    if (callback) payload.callback = callback;
    const scenario = this.config.get<string>('DIDIT_SANDBOX_SCENARIO');
    if (scenario) payload.sandbox_scenario = scenario;

    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.baseUrl()}/v3/session/`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      this.logger.error(`[Didit] session request failed: ${(e as Error)?.name}`);
      throw new ServiceUnavailableException(DIDIT_UNAVAILABLE);
    }

    if (!res.ok) {
      const detail = [401, 403, 429].includes(res.status) ? ` ${text.replace(/\s+/g, ' ').slice(0, 200)}` : '';
      this.logger.error(`[Didit] session -> ${res.status}${detail}`);
      throw new ServiceUnavailableException(DIDIT_UNAVAILABLE);
    }
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (typeof body?.session_id !== 'string' || !body.session_id || typeof body?.url !== 'string' || !body.url) {
      this.logger.error('[Didit] session -> unusable response');
      throw new ServiceUnavailableException(DIDIT_UNAVAILABLE);
    }
    return { sessionId: body.session_id, url: body.url };
  }

  verifyWebhook(body: unknown, signature: string | undefined, nowMs: number = Date.now()): WebhookCheck {
    const secret = this.config.get<string>('DIDIT_WEBHOOK_SECRET');
    if (!secret) return 'not_configured';
    if (typeof signature !== 'string') return 'bad_signature';
    const expected = Buffer.from(signWebhookBody(body, secret), 'utf8');
    const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad_signature';
    const ts = Number((body as Record<string, unknown>)?.timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > WEBHOOK_MAX_SKEW_SECONDS) return 'stale';
    return 'ok';
  }
}
