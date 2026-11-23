import { EMAIL_TEMPLATES, emailShell } from '../notifications/email-templates';
import { NON_TRANSACTIONAL_EVENTS } from '../notifications/notifications.service';

export const HOST_INVITATION_EVENT = 'host.invitation';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Registered at module init so no shared template file needs editing. Marked non-transactional => List-Unsubscribe + footer. */
export function registerHostInvitationEmail(): void {
  NON_TRANSACTIONAL_EVENTS.add(HOST_INVITATION_EVENT);
  EMAIL_TEMPLATES[HOST_INVITATION_EVENT] = (d, { appUrl, logoIconUrl }) => ({
    subject: 'Claim your property on RhenBasera',
    html: emailShell({
      preheader: 'Your property is listed on RhenBasera. Claim it.',
      bodyHtml: `<p style="margin:0 0 12px;">Hi${d.hostName ? ` ${esc(d.hostName)}` : ''},</p>
        <p style="margin:0 0 12px;">${d.propertyName ? `<strong>${esc(d.propertyName)}</strong> appears` : 'Your property appears'} on RhenBasera, a direct-booking platform for stays in Himachal. You can claim it, verify it and start receiving enquiries.</p>
        <p style="margin:0;">This link is personal to you and expires on ${esc(d.expiresOn)}. If you are not interested, ignore this email or opt out using the link on the claim page.</p>`,
      ctaLabel: 'Claim your property',
      ctaLink: esc(d.claimUrl),
      appUrl,
      logoIconUrl,
    }),
  });
}
