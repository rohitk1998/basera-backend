// Ported verbatim from supabase/functions/notification-dispatcher/index.ts —
// the email shell + per-event templates. This is customer-facing copy;
// every string and every inline style here matters.

// ── Email shell ───────────────────────────────────────────────────────────
// Table-based layout with every rule inlined: the only markup that survives
// unpredictably-aggressive CSS stripping across real inboxes (Gmail app,
// Outlook desktop). No external stylesheet, no <style> block, no web font —
// all three are stripped or ignored somewhere in the matrix of clients this
// has to render in. System font stack mirrors --body in app/globals.css as
// closely as an email can.
const BRAND_GREEN = '#00a67d';
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const SURFACE_2 = '#f8fafc';
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

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

// ── Email templates ───────────────────────────────────────────────────────
// One human sentence, one clear next step. Every event name that produces
// an email is called with exactly this key from an app route — see
// grep -rn "notify(" app/api — so a key here with no caller, or a caller
// with no key here, is a real gap, not a naming choice.
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
  'booking.requested': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.guestName ?? 'A guest'} wants to stay at ${d.listingTitle}`,
    html: emailShell({
      preheader: `New booking request for ${d.listingTitle}`,
      bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${d.guestName ?? 'A guest'}</strong> would like to stay at
        <strong>${d.listingTitle}</strong>, moving in ${d.moveIn}.</p>
        <p style="margin: 0;">Reply within 24 hours — guests can see how quickly hosts usually respond.</p>
      `,
      ctaLabel: 'Review the request',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.confirmed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.hostName ?? 'Your host'} confirmed your stay at ${d.listingTitle}`,
    html: emailShell({
      preheader: `Your booking at ${d.listingTitle} is confirmed`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">Good news — <strong>${d.hostName ?? 'your host'}</strong> confirmed your stay at
        <strong>${d.listingTitle}</strong>${d.moveIn ? `, from ${d.moveIn}` : ''}.</p>
        <p style="margin: 0;">Pay directly by UPI or cash when you arrive. Basera never holds or moves this money on your behalf.</p>
      `,
      ctaLabel: 'Message your host',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.declined': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Your request for ${d.listingTitle} wasn't accepted`,
    html: emailShell({
      preheader: `Your booking request was declined`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The host wasn't able to accept your request for <strong>${d.listingTitle}</strong> this time.</p>
        <p style="margin: 0;">This happens for all sorts of reasons that have nothing to do with you — there are plenty of other verified stays nearby.</p>
      `,
      ctaLabel: 'Browse other stays',
      ctaLink: absoluteLink('/stays'),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.cancelled': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Booking cancelled — ${d.listingTitle}`,
    html: emailShell({
      preheader: `The booking for ${d.listingTitle} was cancelled`,
      bodyHtml: `
        <p style="margin: 0;">The booking for <strong>${d.listingTitle}</strong> has been cancelled. Nothing further is owed on either side.</p>
      `,
      ctaLabel: 'View details',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'booking.completed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `How was your stay at ${d.listingTitle}?`,
    html: emailShell({
      preheader: `Leave a review for ${d.listingTitle}`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">Hope the stay at <strong>${d.listingTitle}</strong> went well.</p>
        <p style="margin: 0;">A quick review helps other guests trust what they're booking, and helps good hosts get found.</p>
      `,
      ctaLabel: 'Write a review',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'listing.live': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.listingTitle} is live on Basera`,
    html: emailShell({
      preheader: `Your listing passed every check and is now live`,
      bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${d.listingTitle}</strong> has successfully passed all three verification checks — legal, walkthrough, and banking — and is now live for guests to discover and request.</p>
        <p style="margin: 0;">Basera operates on a host-only subscription model, with zero booking fees for guests.</p>
      `,
      ctaLabel: 'View your listing',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'listing.changes_needed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `One thing to fix on ${d.listingTitle}`,
    html: emailShell({
      preheader: `Your listing needs a small correction before it can go live`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">Your listing <strong>${d.listingTitle}</strong> is close, but needs one correction before it can go live:</p>
        <p style="margin: 0 0 12px; padding: 12px 14px; background: ${SURFACE_2}; border-radius: 10px; color: ${INK};">${d.failReason ?? 'See your dashboard for details.'}</p>
        <p style="margin: 0;">Fix it and resubmit — most listings clear review the second time within a day.</p>
      `,
      ctaLabel: 'Review and resubmit',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'verification.layer_passed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.layerName} verification passed`,
    html: emailShell({
      preheader: `One more check cleared`,
      bodyHtml: `
        <p style="margin: 0;">Your <strong>${d.layerName}</strong> verification passed. Once all three checks clear, your listing goes live automatically.</p>
      `,
      ctaLabel: 'View your progress',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'verification.layer_failed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `Your ${d.layerName} verification needs another look`,
    html: emailShell({
      preheader: `Action needed on your ${d.layerName} verification`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">We couldn't verify your <strong>${d.layerName}</strong> yet:</p>
        <p style="margin: 0 0 12px; padding: 12px 14px; background: ${SURFACE_2}; border-radius: 10px; color: ${INK};">${d.failReason ?? 'See your dashboard for details.'}</p>
        <p style="margin: 0;">This is exactly the kind of mismatch the check exists to catch — resubmit once it's fixed.</p>
      `,
      ctaLabel: 'Resubmit',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'message.received': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.senderName ?? 'Someone'} sent you a message`,
    html: emailShell({
      preheader: `New message on Basera`,
      bodyHtml: `
        <p style="margin: 0;">You have a new message from <strong>${d.senderName ?? 'someone'}</strong> on Basera.</p>
      `,
      ctaLabel: 'Read and reply',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  'call.incoming': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `${d.senderName ?? 'Someone'} called you on Basera`,
    html: emailShell({
      preheader: `Missed call on Basera`,
      bodyHtml: `
        <p style="margin: 0;"><strong>${d.senderName ?? 'Someone'}</strong> tried to reach you on Basera. Open the conversation to call back.</p>
      `,
      ctaLabel: 'Open conversation',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
};
