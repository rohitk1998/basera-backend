import { createHash } from 'crypto';

export const AGREEMENT_VERSION = '2026-11-16.1';

export type AgreementInput = {
  listingTitle: string;
  hostFirstName: string;
  guestFirstName: string;
  moveIn: string; // YYYY-MM-DD
  moveOut: string; // YYYY-MM-DD
  months: number;
  monthlyRent: number;
  deposit: number;
  dueAtMoveIn: number;
  checkIn?: string | null;
  checkOut?: string | null;
  pets?: boolean | null;
  smoking?: boolean | null;
  quietHours?: string | null;
  /** flexible | moderate | firm, only when the listing defines one. */
  cancellationPolicy?: string | null;
};

const inr = (n: number) => `Rs. ${n.toLocaleString('en-IN')}`;

export const firstNameOf = (full: string | null | undefined, fallback: string) =>
  (full ?? '').trim().split(/\s+/)[0] || fallback;

/** Deterministic: the same input always renders the same text (no timestamps). */
export const renderAgreement = (i: AgreementInput): string => {
  const lines: string[] = [
    'BOOKING AGREEMENT',
    '',
    `Stay: ${i.listingTitle}`,
    `Host: ${i.hostFirstName}`,
    `Guest: ${i.guestFirstName}`,
    `Dates: ${i.moveIn} to ${i.moveOut} (${i.months} month${i.months === 1 ? '' : 's'})`,
    '',
    'Rent and payment',
    `- Monthly rent: ${inr(i.monthlyRent)}`,
    `- Security deposit: ${i.deposit > 0 ? inr(i.deposit) : 'none'}`,
    `- Due at move-in: ${inr(i.dueAtMoveIn)}`,
    '- The guest pays through RhenBasera. RhenBasera holds that payment until 24 hours after check-in and then releases it to the host, unless a dispute has been raised.',
    '- This is a temporary hold, not an escrow service and not a guarantee of any outcome by RhenBasera.',
    '',
    'Check-in',
    '- The host receives a check-in code when the booking is approved. The guest shares it with the host at arrival to confirm check-in.',
  ];

  const rules: string[] = [];
  if (i.checkIn) rules.push(`Check-in window: ${i.checkIn}`);
  if (i.checkOut) rules.push(`Check-out: ${i.checkOut}`);
  if (i.pets != null) rules.push(`Pets: ${i.pets ? 'allowed' : 'not allowed'}`);
  if (i.smoking != null) rules.push(`Smoking: ${i.smoking ? 'allowed' : 'not allowed'}`);
  if (i.quietHours) rules.push(`Quiet hours: ${i.quietHours}`);
  if (rules.length > 0) {
    lines.push('', 'House rules', ...rules.map((r) => `- ${r}`));
  }

  lines.push('', 'Commitments', `- Both ${i.hostFirstName} and ${i.guestFirstName} agree to honour the dates above.`);
  if (i.cancellationPolicy) {
    lines.push(`- Both agree to follow this listing's cancellation policy: ${i.cancellationPolicy}.`);
  }
  lines.push('- Either party can raise a dispute through RhenBasera if something goes wrong during the stay.');

  return lines.join('\n');
};

export const hashAgreement = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');
