import { notificationCopy } from './notification-copy';

describe('automation event copy', () => {
  it.each([
    'claim.draft_reminder', 'claim.more_info_reminder', 'admin.claim_review_waiting', 'admin.host_invite_stalled',
    'host.listing_draft_reminder', 'admin.verification_overdue', 'admin.inquiry_unassigned', 'admin.inquiry_response_due',
    'booking.checkin_instructions', 'booking.checkout_reminder',
    'booking.review_request', 'booking.payment_reminder',
  ])('%s has English copy and Hindi falls back to it', (ev) => {
    const en = notificationCopy(ev, { listingTitle: 'Loft' });
    expect(en.title).not.toBe(ev);
    expect(en.body).not.toBe('');
    expect(notificationCopy(ev, { listingTitle: 'Loft' }, 'hi').title).toBe(en.title);
  });
});

describe('stay-request event copy', () => {
  const events = ['inquiry.guest_received', 'inquiry.request_sent', 'inquiry.dates_unavailable'];
  it.each(events)('%s has real English and Hindi copy that uses the listing title', (ev) => {
    const en = notificationCopy(ev, { listingTitle: 'Hotel Sunrise' }, 'en');
    const hi = notificationCopy(ev, { listingTitle: 'Hotel Sunrise' }, 'hi');
    for (const c of [en, hi]) {
      expect(c.title).not.toBe(ev);
      expect(c.body).toContain('Hotel Sunrise');
      expect(c.body).not.toMatch(/\{\w+\}/);
    }
    expect(hi.title).not.toBe(en.title); // translated, not an English fallback
    expect(`${en.title}${en.body}${hi.title}${hi.body}`).not.toMatch(/escrow/i);
  });

  it('the removed alternatives event no longer has copy', () => {
    expect(notificationCopy('admin.inquiry_suggest_alternatives', {}).title).toBe('admin.inquiry_suggest_alternatives');
  });
});
