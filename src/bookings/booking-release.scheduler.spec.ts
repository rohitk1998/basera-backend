import { setLockBackends } from '../common/leader-lock';
import { BookingReleaseScheduler } from './booking-release.scheduler';

describe('BookingReleaseScheduler', () => {
  afterEach(() => setLockBackends(undefined));
  const svc = () => ({
    releaseExpiredHolds: jest.fn().mockRejectedValue(new Error('x')),
    expireStaleHolds: jest.fn(),
    sendStayConfirmationPrompts: jest.fn(),
    escalateStaleNegotiations: jest.fn(),
  });

  it('runs every step, isolating failures, when it holds the lock', async () => {
    setLockBackends([{ acquire: async () => async () => undefined }]);
    const s = svc();
    await new BookingReleaseScheduler(s as any).handleExpiredHolds();
    expect(s.escalateStaleNegotiations).toHaveBeenCalled();
  });

  it('does nothing when another replica holds the lock', async () => {
    setLockBackends([{ acquire: async () => null }]);
    const s = svc();
    await new BookingReleaseScheduler(s as any).handleExpiredHolds();
    expect(s.releaseExpiredHolds).not.toHaveBeenCalled();
  });
});
