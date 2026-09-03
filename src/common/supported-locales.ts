// Mirrors web/i18n/config.ts's LOCALES — kept in sync manually since the
// backend and web app are separate packages with no shared import boundary.
// Any locale value outside this set is rejected before it can reach a
// translation provider, a cache table, or the profile's preferred_locale
// column.
// UI temporarily restricted to English + Hindi only. Other locales are
// commented out (not removed) so they can be re-enabled later — see
// web/i18n/config.ts LOCALES for the matching change.
const SUPPORTED_LOCALES = new Set([
  'en',
  'hi',
  // 'bn',
  // 'te',
  // 'mr',
  // 'ta',
  // 'ur',
  // 'gu',
  // 'kn',
  // 'or',
  // 'ml',
  // 'pa',
  // 'as',
  // 'mai',
  // 'sat',
  // 'ks',
  // 'ne',
  // 'sd',
  // 'kok',
  // 'doi',
  // 'mni',
  // 'brx',
  // 'sa',
]);

export function isSupportedLocale(value: string | undefined): value is string {
  return !!value && SUPPORTED_LOCALES.has(value);
}
