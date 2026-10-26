import { NOTIFICATION_COPY, YOUR_LISTING_FALLBACK } from './notification-copy-catalog';
import type { NotificationEvent } from './notifications.types';

const DEFAULT_LOCALE = 'en';

const NAME_FALLBACK: Record<string, Record<'guestName' | 'hostName' | 'userName', string>> = {
  en: { guestName: 'A guest', hostName: 'Your host', userName: 'Someone' },
  hi: { guestName: 'एक गेस्ट', hostName: 'आपके होस्ट', userName: 'कोई' },
};

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? '');
}

export function notificationCopy(
  event: string,
  payload: Record<string, unknown>,
  locale: string = DEFAULT_LOCALE,
): { title: string; body: string } {
  const localeCopy = NOTIFICATION_COPY[locale] ?? NOTIFICATION_COPY[DEFAULT_LOCALE]!;
  const entry = localeCopy[event as NotificationEvent] ?? NOTIFICATION_COPY[DEFAULT_LOCALE]![event as NotificationEvent];

  if (!entry) {
    return { title: event, body: '' };
  }

  const listingTitle =
    typeof payload.listingTitle === 'string'
      ? payload.listingTitle
      : YOUR_LISTING_FALLBACK[locale] ?? YOUR_LISTING_FALLBACK[DEFAULT_LOCALE]!;

  const fallbacks = NAME_FALLBACK[locale] ?? NAME_FALLBACK[DEFAULT_LOCALE]!;
  const nameOrFallback = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() !== '' ? value : fallback;
  const values = {
    listingTitle,
    guestName: nameOrFallback(payload.guestName, fallbacks.guestName),
    hostName: nameOrFallback(payload.hostName, fallbacks.hostName),
    userName: nameOrFallback(payload.userName, fallbacks.userName),
  };

  return {
    title: interpolate(entry.title, values),
    body: interpolate(entry.body, values),
  };
}
