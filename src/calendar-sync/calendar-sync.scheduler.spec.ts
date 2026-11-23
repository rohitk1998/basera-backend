import { setLockBackends } from '../common/leader-lock';
import { CalendarSyncScheduler } from './calendar-sync.scheduler';

describe('CalendarSyncScheduler', () => {
  afterEach(() => setLockBackends(undefined));
  it('syncs only when it wins the lock', async () => {
    const s = { syncAll: jest.fn() };
    setLockBackends([{ acquire: async () => null }]);
    await new CalendarSyncScheduler(s as any).refresh();
    expect(s.syncAll).not.toHaveBeenCalled();
    setLockBackends([{ acquire: async () => async () => undefined }]);
    await new CalendarSyncScheduler(s as any).refresh();
    expect(s.syncAll).toHaveBeenCalledTimes(1);
  });
});
