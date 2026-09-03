export type NotificationEvent =
  | 'user.registered'
  | 'booking.requested'
  | 'booking.declined'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'booking.completed'
  | 'booking.payment_held'
  | 'booking.checkin_code_ready'
  | 'booking.checked_in'
  | 'booking.checked_out'
  | 'booking.disputed'
  | 'listing.live'
  | 'listing.changes_needed'
  | 'message.received'
  | 'call.incoming'
  | 'verification.layer_passed'
  | 'verification.layer_failed';

export interface NotificationData {
  // Common
  listingTitle?: string;
  link?: string;
  // Push overrides
  pushTitle?: string;
  pushBody?: string;
  // Event-specific
  userName?: string;
  guestName?: string;
  hostName?: string;
  senderName?: string;
  isHost?: boolean;
  moveIn?: string;
  layerName?: string;
  failReason?: string;
  [key: string]: unknown;
}
