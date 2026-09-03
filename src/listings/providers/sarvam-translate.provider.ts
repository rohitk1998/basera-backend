import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import type { TranslatableFields } from '../listing-translation.util';
import type { DetectResult, TranslateProvider, TranslateResult } from './translate-provider.interface';

const API_BASE = 'https://api.sarvam.ai';
const MODEL = 'sarvam-translate:v1';

// Process-wide cap on concurrent outbound Sarvam calls. A single listing
// already fans out to ~10+ calls (one per field); without a shared cap,
// several simultaneous cache-miss listings could fan out to hundreds of
// concurrent HTTP requests and trip Sarvam's own rate limiting. Shared
// across all callers (translate + detect), not per-listing, since the
// external API is the actual bottleneck.
const limit = pLimit(20);

// Sarvam's language codes are our bare locale + '-IN', except Odia, which
// Sarvam spells 'od' where our locale list (and ISO 639) uses 'or'.
const LOCALE_TO_SARVAM: Record<string, string> = { or: 'od' };

function toSarvamCode(locale: string): string {
  return `${LOCALE_TO_SARVAM[locale] ?? locale}-IN`;
}

/**
 * Sarvam AI translation (sarvam-translate:v1) — covers all 22 scheduled
 * Indian languages + English, no corporate KYC, low per-call cost. Chosen
 * over Google Cloud Translation because it doesn't require the KYC-gated
 * Google Cloud billing account. Degrades to 'skipped' when no key is
 * configured, matching every other external-API integration in this
 * codebase (Resend, Firebase, Unsplash).
 *
 * Unlike Google's batch endpoint, Sarvam's /translate takes one string per
 * call — every translatable field is sent as its own concurrent request.
 */
@Injectable()
export class SarvamTranslateProvider implements TranslateProvider {
  private readonly logger = new Logger(SarvamTranslateProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | undefined {
    return this.config.get<string>('SARVAM_API_KEY');
  }

  private async translateOne(text: string, from: string, to: string, apiKey: string): Promise<string | null> {
    if (!text) return text;
    return limit(async () => {
      try {
        const res = await fetch(`${API_BASE}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-subscription-key': apiKey },
          body: JSON.stringify({
            input: text,
            source_language_code: toSarvamCode(from),
            target_language_code: toSarvamCode(to),
            model: MODEL,
          }),
        });
        if (!res.ok) {
          // Body/status only — never log the key itself or the translated text.
          this.logger.warn(`translate ${from}->${to} failed: HTTP ${res.status}`);
          return null;
        }
        const body = await res.json();
        return typeof body?.translated_text === 'string' ? body.translated_text : null;
      } catch (err: any) {
        this.logger.warn(`translate ${from}->${to} errored: ${err?.message ?? err}`);
        return null;
      }
    });
  }

  async detect(sampleText: string): Promise<DetectResult> {
    const apiKey = this.apiKey;
    if (!apiKey) return { status: 'skipped' };

    // Sarvam has no standalone detect endpoint outside a translate call;
    // mayura:v1 accepts 'auto' as source and echoes back what it detected.
    return limit(async () => {
      try {
        const res = await fetch(`${API_BASE}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-subscription-key': apiKey },
          body: JSON.stringify({
            input: sampleText,
            source_language_code: 'auto',
            target_language_code: 'en-IN',
            model: 'mayura:v1',
          }),
        });
        if (!res.ok) {
          this.logger.warn(`detect failed: HTTP ${res.status}`);
          return { status: 'failed' as const };
        }

        const body = await res.json();
        const detected: string | undefined = body?.source_language_code;
        if (!detected) return { status: 'failed' as const };

        const bareLocale = detected.split('-')[0];
        const locale =
          Object.entries(LOCALE_TO_SARVAM).find(([, sarvam]) => sarvam === bareLocale)?.[0] ?? bareLocale;
        return { status: 'ok' as const, locale };
      } catch (err: any) {
        this.logger.warn(`detect errored: ${err?.message ?? err}`);
        return { status: 'failed' as const };
      }
    });
  }

  async translate(fields: TranslatableFields, from: string, to: string): Promise<TranslateResult> {
    const apiKey = this.apiKey;
    if (!apiKey) return { status: 'skipped' };

    const [title, description, theSpace, guestAccess, houseRulesCheckIn, houseRulesCheckOut, ...amenityLabels] =
      await Promise.all([
        this.translateOne(fields.title, from, to, apiKey),
        this.translateOne(fields.description, from, to, apiKey),
        fields.theSpace === null ? Promise.resolve(null) : this.translateOne(fields.theSpace, from, to, apiKey),
        fields.guestAccess === null ? Promise.resolve(null) : this.translateOne(fields.guestAccess, from, to, apiKey),
        this.translateOne(fields.houseRulesCheckIn, from, to, apiKey),
        this.translateOne(fields.houseRulesCheckOut, from, to, apiKey),
        ...fields.amenityLabels.map((label) => this.translateOne(label, from, to, apiKey)),
      ]);

    // Any single failed call fails the whole listing rather than caching a
    // half-translated result — a partial cache entry would be served as
    // 'ready' on every future request for this (listing, locale) pair.
    if (title === null || description === null || houseRulesCheckIn === null || houseRulesCheckOut === null) {
      return { status: 'failed' };
    }
    if (fields.theSpace !== null && theSpace === null) return { status: 'failed' };
    if (fields.guestAccess !== null && guestAccess === null) return { status: 'failed' };
    if (amenityLabels.some((label) => label === null)) return { status: 'failed' };

    return {
      status: 'ok',
      fields: {
        title,
        description,
        theSpace,
        guestAccess,
        amenityLabels: amenityLabels as string[],
        houseRulesCheckIn,
        houseRulesCheckOut,
      },
    };
  }
}
