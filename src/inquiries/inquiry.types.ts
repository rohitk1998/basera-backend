export const INQUIRY_STATES = [
  'NEW',
  'ASSIGNED',
  'HOST_CONTACTING',
  'HOST_RESPONDED',
  'OFFER_PENDING',
  'OFFER_SENT',
  'CONVERTED',
  'DECLINED',
  'EXPIRED',
  'CLOSED',
] as const;
export type InquiryState = (typeof INQUIRY_STATES)[number];
