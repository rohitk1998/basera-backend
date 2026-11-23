import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { WhatsappMessageEntity } from './whatsapp-message.entity';
import { WHATSAPP_TEMPLATES, WhatsappTemplateName } from './whatsapp-templates';
import { CONSENT_CHECKER, type ConsentChecker, E164_REGEX, OPT_OUT_KEYWORDS, SendOutcome, STATUS_RANK } from './whatsapp.types';

export interface SendTemplateInput {
  to: string;
  template: WhatsappTemplateName;
  /** Values keyed by the template's bodyParams names. */
  params: Record<string, string>;
  relatedType?: string;
  relatedId?: string;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(WhatsappMessageEntity) private readonly messages: Repository<WhatsappMessageEntity>,
    @Inject(CONSENT_CHECKER) private readonly consent: ConsentChecker,
  ) {}

  private get dryRun(): boolean {
    return String(this.config.get('WHATSAPP_DRY_RUN') ?? '').toLowerCase() === 'true';
  }

  isConfigured(): boolean {
    return !!(this.config.get('WHATSAPP_PHONE_NUMBER_ID') && this.config.get('WHATSAPP_ACCESS_TOKEN'));
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendOutcome> {
    const def = WHATSAPP_TEMPLATES[input.template];
    if (!def) return { status: 'blocked', reason: 'blocked: unknown template' };
    if (!E164_REGEX.test(input.to)) return { status: 'blocked', reason: 'blocked: invalid E.164 number' };
    const missing = def.bodyParams.filter((p) => typeof input.params[p] !== 'string' || input.params[p] === '');
    if (missing.length) return { status: 'blocked', reason: `blocked: missing params ${missing.join(',')}` };
    if (!this.dryRun && !this.isConfigured()) return { status: 'blocked', reason: 'blocked: not configured' };
    if (!(await this.consent.hasGrantedConsent(input.to))) return { status: 'blocked', reason: 'blocked: no consent' };

    const body = {
      messaging_product: 'whatsapp',
      to: input.to.slice(1),
      type: 'template',
      template: {
        name: def.name,
        language: { code: def.language },
        components: [
          { type: 'body', parameters: def.bodyParams.map((p) => ({ type: 'text', text: input.params[p] })) },
        ],
      },
    };

    if (this.dryRun) {
      this.logger.log(`[dry-run] WhatsApp ${def.name} queued (to ***${input.to.slice(-3)}, related ${input.relatedType ?? '-'}:${input.relatedId ?? '-'})`);
      const id = `dryrun-${randomUUID()}`;
      await this.record(id, input, body, 'queued', null);
      return { status: 'queued', waMessageId: id, dryRun: true };
    }

    const version = this.config.get<string>('WHATSAPP_API_VERSION') || 'v21.0';
    const url = `https://graph.facebook.com/${version}/${this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID')}/messages`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.get<string>('WHATSAPP_ACCESS_TOKEN')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string; code?: number };
      };
      const id = json.messages?.[0]?.id;
      if (!res.ok || !id) {
        const reason = `meta error ${res.status}${json.error?.code ? ` code ${json.error.code}` : ''}: ${json.error?.message ?? 'no message id'}`;
        await this.record(`failed-${randomUUID()}`, input, body, 'failed', reason);
        return { status: 'blocked', reason };
      }
      await this.record(id, input, body, 'sent', null);
      return { status: 'sent', waMessageId: id, dryRun: false };
    } catch (e) {
      const reason = `network error: ${(e as Error).message}`;
      await this.record(`failed-${randomUUID()}`, input, body, 'failed', reason);
      return { status: 'blocked', reason };
    }
  }

  private async record(
    waId: string,
    input: SendTemplateInput,
    payload: object,
    status: WhatsappMessageEntity['status'],
    error: string | null,
  ) {
    try {
      await this.messages.insert({
        direction: 'out',
        wa_message_id: waId,
        to_phone: input.to,
        template_name: input.template,
        payload: payload as any,
        status,
        error,
        related_type: input.relatedType ?? null,
        related_id: input.relatedId ?? null,
        status_updated_at: new Date(),
      });
    } catch (e) {
      this.logger.error(`failed to record whatsapp message: ${(e as Error).message}`);
    }
  }

  /** Process a verified Meta webhook body. Idempotent per wa_message_id. */
  async handleWebhook(body: any): Promise<{ statuses: number; inbound: number }> {
    let statuses = 0;
    let inbound = 0;
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const s of value.statuses ?? []) {
          if (await this.applyStatus(s)) statuses++;
        }
        for (const m of value.messages ?? []) {
          if (await this.applyInbound(m)) inbound++;
        }
      }
    }
    return { statuses, inbound };
  }

  /** Only moves status forward (queued<sent<delivered<read); a duplicate or late event is a no-op. */
  private async applyStatus(s: { id?: string; status?: string; errors?: { code?: number; title?: string }[] }) {
    if (!s?.id || !s.status || !(s.status in STATUS_RANK)) return false;
    const row = await this.messages.findOne({ where: { wa_message_id: s.id, direction: 'out' } });
    if (!row) return false;
    const next = s.status as WhatsappMessageEntity['status'];
    if (row.status === 'failed' || STATUS_RANK[next] <= STATUS_RANK[row.status]) return false;
    await this.messages.update(
      { id: row.id },
      {
        status: next,
        status_updated_at: new Date(),
        error: next === 'failed' ? (s.errors?.map((e) => `${e.code ?? ''} ${e.title ?? ''}`.trim()).join('; ') || 'failed') : row.error,
      },
    );
    return true;
  }

  private async applyInbound(m: { id?: string; from?: string; type?: string; text?: { body?: string } }) {
    if (!m?.id || !m.from) return false;
    const from = `+${m.from.replace(/^\+/, '')}`;
    const res = await this.messages
      .createQueryBuilder()
      .insert()
      .values({
        direction: 'in',
        wa_message_id: m.id,
        from_phone: from,
        payload: { type: m.type ?? null } as any,
        status: 'delivered',
        status_updated_at: new Date(),
      })
      .orIgnore()
      .execute();
    // orIgnore on conflict: duplicate delivery of the same inbound message is skipped.
    if (!res.identifiers?.[0]?.id) return false;
    const text = (m.text?.body ?? '').trim().toLowerCase();
    if (m.type === 'text' && OPT_OUT_KEYWORDS.includes(text)) {
      await this.consent.recordRevocation(from, 'whatsapp_inbound_stop');
      this.logger.log('recorded WhatsApp opt-out');
    }
    return true;
  }
}
