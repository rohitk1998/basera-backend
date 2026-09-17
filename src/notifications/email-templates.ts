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
//
// Deliberately narrow: email fires only for account registration and the
// dispute sub-flow. Everything else in the booking lifecycle (confirmed,
// declined, cancelled, completed, listing status, verification, messages,
// calls) reaches the user through push + in-app only — see notify() in
// notifications.service.ts, which skips email whenever EMAIL_TEMPLATES has
// no entry for the event. Disputes get email because they're money-on-the-
// line and time-boxed (a missed push shouldn't cost someone their response
// window); registration gets it because it's the one message guaranteed to
// land before push permission has even been granted.
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
  'booking.disputed': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `A dispute was raised for ${d.listingTitle}`,
    html: emailShell({
      preheader: `Basera is reviewing a dispute for ${d.listingTitle}`,
      bodyHtml: `
        <p style="margin: 0 0 12px;"><strong>${d.guestName ?? 'Your guest'}</strong> raised a dispute for
        <strong>${d.listingTitle}</strong>. The held payment stays with Basera until this is resolved.</p>
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
        <strong>${d.listingTitle}</strong>.</p>
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
        <p style="margin: 0 0 12px;">The dispute for <strong>${d.listingTitle}</strong> couldn't be settled directly and has been escalated to Basera for review.</p>
        <p style="margin: 0;">You'll hear back once a decision is made — no action is needed from you right now.</p>
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
  // Transactional — sent by the dedicated awaited send path in
  // AuthController.sendEmailOtp, not via notify()/dispatch() like every
  // other row here (a failed OTP email must surface to the caller as an
  // error, not be swallowed the way notify() swallows failures). Kept in
  // this same lookup table anyway so every "what emails does this app
  // send" grep still finds it in one place.
  'auth.otp_code': (d, { appUrl, logoIconUrl }) => ({
    subject: `${d.code} is your Basera code`,
    html: emailShell({
      preheader: `Your Basera sign-in code is ${d.code}`,
      bodyHtml: `
        <p style="margin: 0 0 16px;">Use this code to sign in to Basera. It expires in ${d.expiresInMinutes} minutes.</p>
        <p style="margin: 0; font-size: 32px; font-weight: 700; letter-spacing: 0.3em; color: #1f2937;">${d.code}</p>
        <p style="margin: 16px 0 0; color: #6b7280;">If you didn't request this, you can ignore this email.</p>
      `,
      appUrl,
      logoIconUrl,
    }),
  }),
  'dispute.appeal_raised': (d, { absoluteLink, appUrl, logoIconUrl }) => ({
    subject: `An appeal was raised on ${d.listingTitle}`,
    html: emailShell({
      preheader: `The other party appealed Basera's decision`,
      bodyHtml: `
        <p style="margin: 0 0 12px;">The other party appealed Basera's decision on the dispute for
        <strong>${d.listingTitle}</strong>. This is the one appeal either side gets on this case.</p>
        <p style="margin: 0;">Basera will take a final look and let you know the outcome.</p>
      `,
      ctaLabel: 'View the case',
      ctaLink: absoluteLink(d.link),
      appUrl,
      logoIconUrl,
    }),
  }),
};
