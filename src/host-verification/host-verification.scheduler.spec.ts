import { setLockBackends } from '../common/leader-lock';
import { HostVerificationScheduler } from './host-verification.scheduler';

describe('HostVerificationScheduler', () => {
  afterEach(() => setLockBackends(undefined));
  it('sweeps only when it wins the lock', async () => {
    const s = { sweep: jest.fn().mockResolvedValue({ expired: 0, purged: 0 }) };
    setLockBackends([{ acquire: async () => null }]);
    await new HostVerificationScheduler(s as any).sweep();
    expect(s.sweep).not.toHaveBeenCalled();
    setLockBackends([{ acquire: async () => async () => undefined }]);
    await new HostVerificationScheduler(s as any).sweep();
    expect(s.sweep).toHaveBeenCalledTimes(1);
  });
});
