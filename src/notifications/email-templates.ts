import { calendarDayNumber } from '../common/calendar-date.util';

const BRAND_GREEN ='#00a67d';
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const SURFACE_2 = '#f8fafc';
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatCalendarDate(iso: unknown): string {
  if (typeof iso !== 'string' || isNaN(calendarDayNumber(iso))) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function formatInstantIST(value: unknown): string {
  const date = new Date(String(value ?? ''));
  if (isNaN(date.getTime())) return '';
  const text = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  return `${text} IST`;
}

function formatRupees(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function amountToGuest(d: Record<string, unknown>): string {
  const amount = formatRupees(d.offerAmount);
  return amount ? `: <strong>${escapeHtml(amount)}</strong> back to the guest` : '';
}

function resolutionLines(d: Record<string, unknown>): string {
  const toGuest = formatRupees(d.amountToGuest);
  const toHost = formatRupees(d.amountToHost);
  const lines = [
    toGuest ? `Refunded to the guest: <strong>${escapeHtml(toGuest)}</strong>` : '',
    toHost ? `Released to the host: <strong>${escapeHtml(toHost)}</strong>` : '',
  ].filter(Boolean);
  return lines.length ? `<p style="margin: 0 0 12px;">${lines.join('<br />')}</p>` : '';
}

export interface EmailShellOpts {
  preheader: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaLink?: string;
  appUrl: string;
  logoIconUrl: string;
}

export function emailShell(opts: EmailShellOpts): string {
  const { preheader, bodyHtml, ctaLabel, ctaLink, appUrl, logoIconUrl } = opts;

  const cta = ctaLabel && ctaLink
    ? `
      <tr>
        <td style="padding: 8px 0 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="border-radius: 999px; background: ${BRAND_GREEN};">
                <a href="${ctaLink}" style="display: inline-block; padding: 13px 28px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 999px;">
                  ${ctaLabel}
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Basera</title>
  </head>
  <body style="margin: 0; padding: 0; background: ${SURFACE_2}; font-family: ${FONT_STACK};">
    <!-- Preheader: shows in the inbox preview line, hidden in the rendered body -->
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${preheader}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${SURFACE_2};">
      <tr>
        <td align="center" style="padding: 32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid ${LINE};">
            <tr>
              <td style="padding: 24px 32px 20px; border-bottom: 1px solid ${LINE};">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right: 10px;">
                      <img src="${logoIconUrl}" width="28" height="28" alt="" style="display: block; border-radius: 7px;" />
                    </td>
                    <td style="font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: ${INK}; vertical-align: middle;">basera</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="font-size: 15px; line-height: 1.65; color: ${INK};">
                      ${bodyHtml}
                    </td>
                  </tr>
                  ${cta}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 32px 28px; border-top: 1px solid ${LINE};">
                <p style="margin: 0; font-size: 12.5px; line-height: 1.6; color: ${MUTED};">
                  Basera is a long-stay marketplace and direct-booking platform, offering a zero-fee experience for users and a trusted framework for both hosts and users.
                </p>
                <p style="margin: 12px 0 0; font-size: 12.5px; color: ${MUTED};">
                  <a href="${appUrl}/account" style="color: ${MUTED}; text-decoration: underline;">Manage notification preferences</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export type Template = (
  data: Record<string, unknown>,
  ctx: { absoluteLink: (link: unknown) => string; appUrl: string; logoIconUrl: string },
) => { subject: string; html: string };

export const EMAIL_TEMPLATES: Record<string, Template> = {
  'user.registered': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Welcome to Basera${d.userName ? `, ${d.userName}` : ''}`,
    html: emailShell({
      preheader: `Welcome to Basera`,
      bodyHtml: d.isHost
        ? `
          <p style="margin: 0 0 12px;">Welcome to Basera${d.userName ? `, ${d.userName}` : ''}. You're set up as a host.</p>
          <p style="margin: 0;">Before your first listing can go live, complete identity verification in Account &amp; Profile — it's a one-time step that covers every property you list afterwards.</p>
        `
        : `
          <p style="margin: 0 0 12px;">Welcome to Basera${d.userName ? `, ${d.userName}` : ''}.</p>
          <p style="margin: 0;">Complete your KYC to explore stays and services offered by our hosts and enjoy a smooth booking experience.</p>
        `,
      ctaLabel: d.isHost ? 'Complete verification' : 'Browse stays',
      ctaLink: absoluteLink(d.isHost ? '/account?verify=1' : '/stays'),
      appUrl,
      logoIconUrl,
    }),
  }),
  'user.welcome': (d, { absoluteLink, appUrl, logoIconUrl }) => {
    const name = d.userName ? `, ${escapeHtml(d.userName)}` : '';
    return {
      subject: `Welcome to Basera${d.userName ? `, ${d.userName}` : ''}`,
      html: emailShell({
        preheader: `Your Basera account is ready`,
        bodyHtml: d.isHost
          ? `
          <p style="margin: 0 0 12px;">Welcome to Basera${name}. Your account is ready and you're set up as a host.</p>
          <p style="margin: 0;">Next step: start your first listing so guests can find your place.</p>
        `
          : `
          <p style="margin: 0 0 12px;">Welcome to Basera${name}. Your account is ready.</p>
          <p style="margin: 0;">Next step: browse stays and find a place that feels like home.</p>
        `,
        ctaLabel: d.isHost ? 'Start listing' : 'Browse stays',
        ctaLink: absoluteLink(d.isHost ? '/host/start' : '/stays'),
        appUrl,
        logoIconUrl,
      }),
    };
  },
  'booking.confirmed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Your request for ${d.listingTitle} was approved`,
    html: emailShell({
      preheader: `${escapeHtml(d.hostName ?? 'Your host')} approved your request`,
      bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${escapeHtml(d.hostName ?? 'Your host')}</strong> approved your booking request for
        <strong>${escapeHtml(d.listingTitle)}</strong>.</p>
        <p style="margin: 0;">Complete your payment to secure the stay. It is held safely until 24 hours after you check in.</p>
      `,
      ctaLabel: 'Pay now',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.declined': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Your request for ${d.listingTitle} was declined`,
    html: emailShell({
      preheader: `The host declined your booking request`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The host declined your booking request for <strong>${escapeHtml(d.listingTitle)}</strong>.</p>
        <p style="margin: 0;">No payment was taken. You can browse other stays and send a new request.</p>
      `,
      ctaLabel: 'Browse stays',
      ctaLink: absoluteLink('/stays'),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.payment_receipt': (d, { absoluteLink, appUrl, logoIconUrl }) => {
    const moveIn = formatCalendarDate(d.moveIn);
    const moveOut = formatCalendarDate(d.moveOut);
    const amount = formatRupees(d.amount);
    return {
      subject: `Payment receipt for ${d.listingTitle}`,
      html: emailShell({
        preheader: `We received your payment for ${escapeHtml(d.listingTitle)}`,
        bodyHtml: `
        <p style="margin: 0 0 12px;">We received your payment for <strong>${escapeHtml(d.listingTitle)}</strong>.</p>
        <p style="margin: 0 0 12px;">${moveIn && moveOut ? `Stay: ${escapeHtml(moveIn)} to ${escapeHtml(moveOut)}<br />` : ''}${amount ? `Amount paid: <strong>${escapeHtml(amount)}</strong>` : ''}</p>
        <p style="margin: 0;">Basera holds this payment until 24 hours after you check in, then releases it to the host unless you report a problem before then.</p>
      `,
        ctaLabel: 'View your booking',
        ctaLink: absoluteLink(d.link),
        appUrl,
        logoIconUrl,
      }),
    };
  },
  'booking.checkin_confirmed': (d, { absoluteLink, appUrl, logoIconUrl }) => {
    const checkedInAt = formatInstantIST(d.checkinTime);
    const releaseAt = formatInstantIST(d.escrowReleaseTime);
    return {
      subject: `You're checked in at ${d.listingTitle}`,
      html: emailShell({
        preheader: `Check-in confirmed for ${escapeHtml(d.listingTitle)}`,
        bodyHtml: `
        <p style="margin: 0 0 12px;">Your check-in at <strong>${escapeHtml(d.listingTitle)}</strong> is confirmed${checkedInAt ? ` (${escapeHtml(checkedInAt)})` : ''}.</p>
        <p style="margin: 0 0 12px;">${releaseAt ? `Your payment stays held by Basera until <strong>${escapeHtml(releaseAt)}</strong>, then is released to the host.` : 'Your payment stays held by Basera for 24 hours after check-in, then is released to the host.'}</p>
        <p style="margin: 0;">If something isn't right with the stay, report a problem from your booking before then and the payment will stay on hold while Basera reviews it.</p>
      `,
        ctaLabel: 'View your booking',
        ctaLink: absoluteLink(d.link),
        appUrl,
        logoIconUrl,
      }),
    };
  },
  'booking.requested': (d, { absoluteLink, appUrl, logoIconUrl }) => {
    const moveIn = formatCalendarDate(d.moveIn);
    return {
      subject: `New booking request for ${d.listingTitle}`,
      html: emailShell({
        preheader: `${escapeHtml(d.guestName ?? 'A guest')} wants to stay at ${escapeHtml(d.listingTitle)}`,
        bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${escapeHtml(d.guestName ?? 'A guest')}</strong> sent a booking request for <strong>${escapeHtml(d.listingTitle)}</strong>${moveIn ? `, starting ${escapeHtml(moveIn)}` : ''}.</p>
        <p style="margin: 0;">Approve or decline it from your bookings.</p>
      `,
        ctaLabel: 'Review the request',
        ctaLink: absoluteLink(d.link),
        appUrl,
        logoIconUrl,
      }),
    };
  },
  'booking.payment_held': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Payment received for ${d.listingTitle}`,
    html: emailShell({
      preheader: `Your guest has paid for ${escapeHtml(d.listingTitle)}`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">Your guest has paid for <strong>${escapeHtml(d.listingTitle)}</strong>. Basera is holding the payment.</p>
        <p style="margin: 0;">It is released to you 24 hours after check-in, unless the guest reports a problem. Open your bookings in the app to get ready for their arrival.</p>
      `,
      ctaLabel: 'View the booking',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.checked_in': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.guestName ?? 'Your guest'} checked in at ${d.listingTitle}`,
    html: emailShell({
      preheader: `Guest check-in confirmed for ${escapeHtml(d.listingTitle)}`,
      bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${escapeHtml(d.guestName ?? 'Your guest')}</strong> checked in at <strong>${escapeHtml(d.listingTitle)}</strong>.</p>
        <p style="margin: 0;">Basera releases the held payment to you 24 hours after check-in, unless the guest reports a problem before then.</p>
      `,
      ctaLabel: 'View the booking',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.raised_confirmation': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `We received your dispute for ${d.listingTitle}`,
    html: emailShell({
      preheader: `Your dispute for ${escapeHtml(d.listingTitle)} is open`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">Your dispute for <strong>${escapeHtml(d.listingTitle)}</strong> has been sent to the host.</p>
        <p style="margin: 0;">The held payment stays on hold while the host responds. If you can't agree, Basera will review the case.</p>
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.offer_accepted': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Your offer was accepted for ${d.listingTitle}`,
    html: emailShell({
      preheader: `The dispute for ${escapeHtml(d.listingTitle)} is settled`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The other party accepted the offer on the dispute for <strong>${escapeHtml(d.listingTitle)}</strong>. The case is settled.</p>
        ${resolutionLines(d)}
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.offer_rejected': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Your offer was rejected for ${d.listingTitle}`,
    html: emailShell({
      preheader: `The dispute for ${escapeHtml(d.listingTitle)} goes to Basera`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The other party rejected the offer on the dispute for <strong>${escapeHtml(d.listingTitle)}</strong>.</p>
        <p style="margin: 0;">The case has been sent to Basera for review. The held payment stays on hold until it is decided.</p>
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.resolved': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Dispute resolved for ${d.listingTitle}`,
    html: emailShell({
      preheader: `The dispute for ${escapeHtml(d.listingTitle)} has been resolved`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">${d.decidedBy === 'negotiation' ? 'The dispute was settled directly' : 'Basera has made a decision on the dispute'} for <strong>${escapeHtml(d.listingTitle)}</strong>.</p>
        ${resolutionLines(d)}
        ${d.appealable ? '<p style="margin: 0;">Either side can appeal this decision once.</p>' : ''}
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.disputed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `A dispute was raised for ${d.listingTitle}`,
    html: emailShell({
      preheader: `Basera is reviewing a dispute for ${escapeHtml(d.listingTitle)}`,
      bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${escapeHtml(d.guestName ?? 'Your guest')}</strong> raised a dispute for
        <strong>${escapeHtml(d.listingTitle)}</strong>. The held payment stays with Basera until this is resolved.</p>
        <p style="margin: 0;">Review the details and respond — this affects when the payment is released.</p>
      `,
      ctaLabel: 'Review the dispute',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.offer_received': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `New offer on the dispute for ${d.listingTitle}`,
    html: emailShell({
      preheader: `A settlement offer is waiting for your response`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The other party made an offer to settle the dispute for
        <strong>${escapeHtml(d.listingTitle)}</strong>${amountToGuest(d)}.</p>
        <p style="margin: 0;">Accept, counter, or escalate to Basera — the held payment isn't released until this is settled.</p>
      `,
      ctaLabel: 'Respond to the offer',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.escalated': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Dispute for ${d.listingTitle} escalated to Basera`,
    html: emailShell({
      preheader: `Basera will now review this dispute directly`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The dispute for <strong>${escapeHtml(d.listingTitle)}</strong> couldn't be settled directly and has been escalated to Basera for review.</p>
        <p style="margin: 0;">You'll hear back once a decision is made — no action is needed from you right now.</p>
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'auth.otp_code': (d, { appUrl, logoIconUrl }) => {
    const code = escapeHtml(d.code);
    const minutes = escapeHtml(d.expiresInMinutes);
    if (d.purpose === 'signup') {
      return {
        subject: `${d.code} is your Basera verification code`,
        html: emailShell({
          preheader: `Verify your email to finish creating your Basera account`,
          bodyHtml: `
        <p style="margin: 0 0 16px;">Use this code to verify your email and finish creating your Basera account. It expires in ${minutes} minutes.</p>
        <p style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 0.3em; color: #1f2937;">${code}</p>
        <p style="margin: 16px 0 0; color: #6b7280;">If you didn't try to create a Basera account, you can ignore this email.</p>
      `,
          appUrl,
          logoIconUrl,
        }),
      };
    }
    return {
      subject: `${d.code} is your Basera code`,
      html: emailShell({
        preheader: `Your Basera sign-in code is ${code}`,
        bodyHtml: `
        <p style="margin: 0 0 16px;">Use this code to sign in to Basera. It expires in ${minutes} minutes.</p>
        <p style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 0.3em; color: #1f2937;">${code}</p>
        <p style="margin: 16px 0 0; color: #6b7280;">If you didn't request this, you can ignore this email.</p>
      `,
        appUrl,
        logoIconUrl,
      }),
    };
  },
  'dispute.appeal_raised': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `An appeal was raised on ${d.listingTitle}`,
    html: emailShell({
      preheader: `The other party appealed Basera's decision`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The other party appealed Basera's decision on the dispute for
        <strong>${escapeHtml(d.listingTitle)}</strong>. This is the one appeal either side gets on this case.</p>
        <p style="margin: 0;">Basera will take a final look and let you know the outcome.</p>
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
};
