import { NOTIFICATION_COPY, YOUR_LISTING_FALLBACK } from './notification-copy-catalog';
import type { NotificationEvent } from './notifications.types';

const DEFAULT_LOCALE = 'en';

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

/**
 * Locale-aware title/body for a notification, derived from `event` +
 * `payload.listingTitle` against NOTIFICATION_COPY. Ignores any stored
 * `payload.pushTitle`/`pushBody` — those exist only because sendPush()
 * needs plain text at send time (see notifications.service.ts dispatch()),
 * not because they're the source of truth for display copy. Deriving the
 * inbox and the push body from the same catalog+locale, independently,
 * means both the /notifications inbox and the phone's push banner show the
 * viewer's own language rather than whatever locale the recipient's push
 * happened to be rendered in at send time.
 */
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

  return {
    title: interpolate(entry.title, { listingTitle }),
    body: interpolate(entry.body, { listingTitle }),
  };
}
