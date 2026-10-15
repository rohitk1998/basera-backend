import { EMAIL_TEMPLATES } from './email-templates';

const ctx = {
  absoluteLink: (l: unknown) => `https://app.test${String(l)}`,
  appUrl: 'https://app.test',
  logoIconUrl: 'https://app.test/logo.png',
};

describe('guest payment receipt email', () => {
  const render = (extra: Record<string, unknown> = {}) =>
    EMAIL_TEMPLATES['booking.payment_receipt']!(
      { listingTitle: 'Cozy <b>Flat</b>', moveIn: '2026-11-01', moveOut: '2026-11-10', amount: 12500, link: '/stays', ...extra },
      ctx,
    );

  it('shows title, calendar dates and amount, with the hold-and-release note', () => {
    const { html } = render();
    expect(html).toContain('1 Nov 2026 to 10 Nov 2026');
    expect(html).toContain('₹12,500');
    expect(html).toContain('24 hours after you check in');
    expect(html).not.toMatch(/escrow|guarantee/i);
  });

  it('escapes interpolated values', () => {
    const { html } = render();
    expect(html).toContain('Cozy &#60;b&#62;Flat&#60;/b&#62;');
    expect(html).not.toContain('<b>Flat</b>');
  });

  it('never outputs a check-in code even if one is in the payload', () => {
    const { html, subject } = render({ checkin_code: '4821', checkinCode: '4821', code: '4821' });
    expect(html).not.toContain('4821');
    expect(subject).not.toContain('4821');
  });
});

describe('guest check-in confirmation email', () => {
  const render = (extra: Record<string, unknown> = {}) =>
    EMAIL_TEMPLATES['booking.checkin_confirmed']!(
      {
        listingTitle: 'A & B "Home"',
        checkinTime: '2026-11-01T09:30:00.000Z',
        escrowReleaseTime: '2026-11-02T09:30:00.000Z',
        link: '/stays',
        ...extra,
      },
      ctx,
    );

  it('shows check-in time and release time in IST', () => {
    const { html } = render();
    expect(html).toMatch(/1 Nov 2026, 3:00 pm IST/i);
    expect(html).toMatch(/2 Nov 2026, 3:00 pm IST/i);
    expect(html).toContain('report a problem');
  });

  it('escapes interpolated values', () => {
    const { html } = render();
    expect(html).toContain('A &#38; B &#34;Home&#34;');
  });

  it('never outputs a check-in code', () => {
    expect(render({ checkinCode: '4821', checkin_code: '4821' }).html).not.toContain('4821');
  });
});

describe('host and dispute emails', () => {
  const evil = { listingTitle: 'A <i>&</i> "B"', guestName: '<script>x</script>', link: '/host?tab=bookings' };
  const codeFields = { checkin_code: '4821', checkinCode: '4821', code: '4821' };
  const events = [
    'booking.requested',
    'booking.payment_held',
    'booking.checked_in',
    'booking.disputed',
    'dispute.raised_confirmation',
    'dispute.offer_received',
    'dispute.offer_accepted',
    'dispute.offer_rejected',
    'dispute.escalated',
    'dispute.resolved',
    'dispute.appeal_raised',
  ];

  it.each(events)('%s escapes values and never prints a check-in code', (event) => {
    const { html } = EMAIL_TEMPLATES[event]!({ ...evil, ...codeFields }, ctx);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&#60;');
    expect(html).not.toContain('4821');
    expect(html).not.toMatch(/escrow|guarantee/i);
    expect(html).toContain('https://app.test/host?tab=bookings');
  });

  it('resolution email shows refund and host amounts', () => {
    const { html } = EMAIL_TEMPLATES['dispute.resolved']!(
      { listingTitle: 'Flat', amountToGuest: 3000, amountToHost: 9500, decidedBy: 'admin', link: '/' },
      ctx,
    );
    expect(html).toContain('₹3,000');
    expect(html).toContain('₹9,500');
  });

  it('offer email shows the offered amount', () => {
    const { html } = EMAIL_TEMPLATES['dispute.offer_received']!({ listingTitle: 'Flat', offerAmount: 2000, link: '/' }, ctx);
    expect(html).toContain('₹2,000');
  });

  it('booking request email shows the move-in calendar date', () => {
    const { html } = EMAIL_TEMPLATES['booking.requested']!({ listingTitle: 'Flat', guestName: 'Asha', moveIn: '2026-11-01', link: '/' }, ctx);
    expect(html).toContain('1 Nov 2026');
  });
});

describe('OTP email (auth.otp_code)', () => {
  const render = (extra: Record<string, unknown> = {}) =>
    EMAIL_TEMPLATES['auth.otp_code']!({ code: '123456', expiresInMinutes: 10, ...extra }, ctx);

  it('signup wording asks to verify the email and finish creating the account', () => {
    const { subject, html } = render({ purpose: 'signup' });
    expect(subject).toContain('verification code');
    expect(html).toContain('verify your email and finish creating your Basera account');
    expect(html).toContain('expires in 10 minutes');
    expect(html).not.toContain('sign in to Basera');
  });

  it('login wording keeps "sign in"', () => {
    const { subject, html } = render({ purpose: 'login' });
    expect(subject).toBe('123456 is your Basera code');
    expect(html).toContain('sign in to Basera');
    expect(html).not.toContain('finish creating');
  });

  it('defaults to the login wording when no purpose is given', () => {
    expect(render().html).toContain('sign in to Basera');
  });

  it('escapes the code and expiry', () => {
    const { html } = render({ purpose: 'signup', code: '<i>1</i>', expiresInMinutes: '<b>' });
    expect(html).not.toContain('<i>1</i>');
    expect(html).not.toContain('<b>');
  });
});

describe('welcome email (user.welcome)', () => {
  const render = (extra: Record<string, unknown> = {}) =>
    EMAIL_TEMPLATES['user.welcome']!({ userName: 'Jane', isHost: false, ...extra }, ctx);

  it('guest: points to browsing stays', () => {
    const { subject, html } = render();
    expect(subject).toBe('Welcome to Basera, Jane');
    expect(html).toContain('browse stays');
    expect(html).toContain('https://app.test/stays');
  });

  it('host: points to starting a listing', () => {
    const { html } = render({ isHost: true });
    expect(html).toContain('start your first listing');
    expect(html).toContain('https://app.test/host/start');
  });

  it('escapes the name', () => {
    const { html } = render({ userName: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&#60;script&#62;');
  });

  it('never leaks a code even if one is in the payload', () => {
    const { html, subject } = render({ code: '654321', otp: '654321' });
    expect(html).not.toContain('654321');
    expect(subject).not.toContain('654321');
  });
});
