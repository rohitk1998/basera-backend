import { EMAIL_TEMPLATES } from './email-templates';

const ctx = {
  absoluteLink: (l: unknown) => `https://app.test${String(l)}`,
  appUrl: 'https://app.test',
  logoIconUrl: 'https://app.test/logo.png',
};
const data = {
  guestName: 'Asha',
  propertyName: 'Hotel Sunrise',
  town: 'Manali',
  checkIn: '12 Dec 2026',
  checkOut: '15 Dec 2026',
  guests: 2,
  ref: 'RQ-AJTZ9R',
};
const render = (ev: string, extra: Record<string, unknown> = {}) => EMAIL_TEMPLATES[ev]!({ ...data, ...extra }, ctx);

describe('stay-request emails', () => {
  it.each(['inquiry.guest_received', 'inquiry.new', 'inquiry.request_sent', 'inquiry.dates_unavailable'])('%s renders without owner phone or escrow wording', (ev) => {
    const { subject, html } = render(ev, { link: '/x', phone: '+919816012345', ownerPhone: '+919816012345' });
    expect(subject).toBeTruthy();
    expect(html).toContain('Hotel Sunrise'.slice(0, 5));
    expect(html + subject).not.toMatch(/escrow|9816012345/i);
  });

  it('guest_received: subject, ref, dates, guests; CTA only when a link exists', () => {
    const a = render('inquiry.guest_received');
    expect(a.subject).toBe('We got your stay request for Hotel Sunrise');
    expect(a.html).toContain('RQ-AJTZ9R');
    expect(a.html).toContain('12 Dec 2026');
    expect(a.html).toContain('2 guests');
    expect(a.html).not.toContain('View your request');
    const b = render('inquiry.guest_received', { link: '/stays/request/RQ-AJTZ9R?token=abc' });
    expect(b.html).toContain('View your request');
    expect(b.html).toContain('https://app.test/stays/request/RQ-AJTZ9R?token=abc');
  });

  it('inquiry.new goes to staff with an Open the request link', () => {
    const { subject, html } = render('inquiry.new', { link: '/admin' });
    expect(subject).toBe('New stay request: Hotel Sunrise');
    expect(html).toContain('Call the owner');
    expect(html).toContain('Open the request');
    expect(html).toContain('https://app.test/admin');
  });

  it('request_sent says the guest pays only after approval', () => {
    const { subject, html } = render('inquiry.request_sent', { link: '/account' });
    expect(subject).toBe('Your request was sent to the owner of Hotel Sunrise');
    expect(html).toContain('You pay only after they approve');
    expect(html).toContain('View your booking request');
  });

  it('dates_unavailable links to the verified stays in the town', () => {
    const { subject, html } = render('inquiry.dates_unavailable', { link: '/stays?q=Manali' });
    expect(subject).toBe('Hotel Sunrise is not available for your dates');
    expect(html).toContain('already been booked by someone else');
    expect(html).toContain('See verified stays in Manali');
    expect(html).toContain('href="https://app.test/stays?q=Manali"');
  });

  it('dates_unavailable without a town drops the town wording', () => {
    const { html } = render('inquiry.dates_unavailable', { town: '', link: '/stays' });
    expect(html).toContain('verified stays you can book instead');
    expect(html).toContain('See verified stays');
    expect(html).not.toContain('See verified stays in');
  });

  it('keeps the link query intact (no HTML-escaping of the URL)', () => {
    const { html } = render('inquiry.dates_unavailable', { link: '/stays?q=Old%20Manali&x=1' });
    expect(html).toContain('https://app.test/stays?q=Old%20Manali&x=1');
  });

  it.each(['inquiry.guest_received', 'inquiry.new', 'inquiry.request_sent', 'inquiry.dates_unavailable'])('%s escapes interpolated values', (ev) => {
    const { html } = render(ev, { guestName: '<img src=x onerror=1>', propertyName: '<b>Evil</b>', town: '"><script>', ref: '<i>r</i>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<i>r</i>');
  });
});
