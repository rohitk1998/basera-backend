import { notificationCopy } from './notification-copy';

describe('notificationCopy', () => {
  it('interpolates guestName from payload', () => {
    const { body } = notificationCopy('booking.checked_in', { guestName: 'Asha', listingTitle: 'Loft' });
    expect(body).toContain('Asha');
    expect(body).not.toMatch(/\{\w+\}/);
  });

  it('falls back when guestName is missing, in both locales', () => {
    expect(notificationCopy('booking.disputed', {}).body).toContain('A guest');
    expect(notificationCopy('booking.disputed', {}, 'hi').body).not.toMatch(/\{\w+\}/);
  });
});
