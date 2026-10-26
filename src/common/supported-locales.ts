const SUPPORTED_LOCALES = new Set([
  'en',
  'hi',
]);

export function isSupportedLocale(value: string | undefined): value is string {
  return !!value && SUPPORTED_LOCALES.has(value);
}
