import { setLockBackends } from '../common/leader-lock';
import { AttractionsScheduler } from './attractions.scheduler';

describe('AttractionsScheduler', () => {
  afterEach(() => setLockBackends(undefined));
  const imp = () => ({ isConfigured: () => true, getStatus: () => ({ running: false }), runNow: jest.fn() });
  it('imports only when it wins the lock', async () => {
    const i = imp();
    setLockBackends([{ acquire: async () => null }]);
    await new AttractionsScheduler(i as any).quarterlyImport();
    expect(i.runNow).not.toHaveBeenCalled();
    setLockBackends([{ acquire: async () => async () => undefined }]);
    await new AttractionsScheduler(i as any).quarterlyImport();
    expect(i.runNow).toHaveBeenCalledTimes(1);
  });
});
