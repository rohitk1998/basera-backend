/**
 * WhatsApp template registry.
 * MUST BE APPROVED IN META (WhatsApp Manager > Message templates) BEFORE USE.
 * Name, language and the count/order of body params must match the approved template exactly.
 * Business-initiated messages outside a 24h customer window can only be templates.
 */
export interface WhatsappTemplateDef {
  name: string;
  language: string;
  /** Meta category you should submit it under. */
  category: 'UTILITY' | 'MARKETING';
  /** Ordered body variables {{1}}, {{2}}... */
  bodyParams: readonly string[];
  /** Suggested body text to submit for approval. */
  suggestedBody: string;
  /** Sample values (same order as bodyParams) to paste into Meta's template submission form. */
  sampleParams?: readonly string[];
}

export const WHATSAPP_TEMPLATES = {
  host_invitation: {
    name: 'host_invitation', language: 'en', category: 'MARKETING',
    bodyParams: ['host_name', 'claim_url'],
    suggestedBody: 'Hi {{1}}, your property has been listed on RhenBasera. Claim it here: {{2}}',
  },
  claim_reminder: {
    name: 'claim_reminder', language: 'en', category: 'MARKETING',
    bodyParams: ['host_name', 'claim_url'],
    suggestedBody: 'Hi {{1}}, a reminder to claim your RhenBasera listing: {{2}}',
  },
  inquiry_alert: {
    name: 'inquiry_alert', language: 'en', category: 'UTILITY',
    bodyParams: ['host_name', 'listing_title', 'inquiry_url'],
    suggestedBody: 'Hi {{1}}, you have a new inquiry for {{2}}. View it: {{3}}',
  },
  offer_sent: {
    name: 'offer_sent', language: 'en', category: 'UTILITY',
    bodyParams: ['guest_name', 'listing_title', 'offer_url'],
    suggestedBody: 'Hi {{1}}, the host sent you an offer for {{2}}. Review it: {{3}}',
  },
  payment_reminder: {
    name: 'payment_reminder', language: 'en', category: 'UTILITY',
    bodyParams: ['guest_name', 'listing_title', 'pay_url'],
    suggestedBody: 'Hi {{1}}, complete payment for your stay at {{2}}: {{3}}',
  },
  booking_confirmed: {
    name: 'booking_confirmed', language: 'en', category: 'UTILITY',
    bodyParams: ['guest_name', 'listing_title', 'check_in_date'],
    suggestedBody: 'Hi {{1}}, your booking at {{2}} from {{3}} is confirmed.',
  },
  stay_request_received: {
    name: 'stay_request_received', language: 'en', category: 'UTILITY',
    bodyParams: ['guest_name', 'property_name', 'check_in_date', 'check_out_date'],
    suggestedBody: 'Hi {{1}}, we have received your stay request for {{2}} from {{3}} to {{4}}. We are contacting the owner and will update you here and by email.',
    sampleParams: ['Asha', 'Hotel Sunrise Manali', '12 Dec 2026', '15 Dec 2026'],
  },
  stay_request_admin_alert: {
    name: 'stay_request_admin_alert', language: 'en', category: 'UTILITY',
    bodyParams: ['admin_name', 'request_ref', 'guest_name', 'property_name', 'check_in_date', 'check_out_date'],
    suggestedBody: 'Hi {{1}}, new stay request {{2}} from {{3}} for {{4}}, {{5}} to {{6}}. Open the admin console to contact the owner. Thank you.',
    sampleParams: ['Admin', 'RQ-AJTZ9R', 'Asha', 'Hotel Sunrise Manali', '12 Dec 2026', '15 Dec 2026'],
  },
  stay_request_sent_to_owner: {
    name: 'stay_request_sent_to_owner', language: 'en', category: 'UTILITY',
    bodyParams: ['guest_name', 'property_name', 'check_in_date', 'check_out_date', 'bookings_url'],
    suggestedBody: 'Hi {{1}}, good news. The owner of {{2}} is now on RhenBasera and your request for {{3}} to {{4}} is with them for approval. You can follow it here: {{5}} We will message you when they respond.',
    sampleParams: ['Asha', 'Hotel Sunrise Manali', '12 Dec 2026', '15 Dec 2026', 'https://www.rhenbasera.online/settings?tab=bookings'],
  },
  stay_dates_unavailable: {
    name: 'stay_dates_unavailable', language: 'en', category: 'UTILITY',
    bodyParams: ['guest_name', 'property_name', 'check_in_date', 'check_out_date', 'stays_url'],
    suggestedBody: 'Hi {{1}}, sorry, {{2}} is not available from {{3}} to {{4}}. It is unavailable for these dates or already booked by someone else. See verified stays nearby here: {{5}} We hope to host you soon.',
    sampleParams: ['Asha', 'Hotel Sunrise Manali', '12 Dec 2026', '15 Dec 2026', 'https://www.rhenbasera.online/stays?q=Manali'],
  },
} as const satisfies Record<string, WhatsappTemplateDef>;

export type WhatsappTemplateName = keyof typeof WHATSAPP_TEMPLATES;
