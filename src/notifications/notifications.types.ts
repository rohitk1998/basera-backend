export type NotificationEvent =
  | 'user.registered'
  | 'user.welcome'
  | 'booking.requested'
  | 'booking.declined'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'booking.completed'
  | 'booking.payment_held'
  | 'booking.payment_receipt'
  | 'booking.checkin_confirmed'
  | 'booking.checkin_code_ready'
  | 'booking.checked_in'
  | 'booking.checked_out'
  | 'booking.checked_out_early'
  | 'booking.disputed'
  | 'dispute.raised_confirmation'
  | 'dispute.offer_received'
  | 'dispute.offer_accepted'
  | 'dispute.offer_rejected'
  | 'dispute.resolved'
  | 'dispute.escalated'
  | 'dispute.appeal_raised'
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
