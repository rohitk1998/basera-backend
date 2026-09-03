import type { TranslatableFields } from '../listing-translation.util';

export type TranslatedFields = {
  title: string;
  description: string;
  theSpace: string | null;
  guestAccess: string | null;
  amenityLabels: string[];
  houseRulesCheckIn: string;
  houseRulesCheckOut: string;
};

export type TranslateResult = { status: 'ok'; fields: TranslatedFields } | { status: 'skipped' | 'failed' };

export type DetectResult = { status: 'ok'; locale: string } | { status: 'skipped' | 'failed' };

/** Swappable MT backend — lets a locale be routed to a different provider
 *  (e.g. Bhashini for low-resource languages) without reshaping the
 *  translation service itself. */
export interface TranslateProvider {
  translate(fields: TranslatableFields, from: string, to: string): Promise<TranslateResult>;
  detect(sampleText: string): Promise<DetectResult>;
}
