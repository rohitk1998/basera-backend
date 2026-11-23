import { PaymentsReconcileScheduler, RECONCILE_JOB } from './payments-reconcile.scheduler';
import { QUEUE_AUTOMATION, QueueJobRegistry } from '../queue';

describe('PaymentsReconcileScheduler job registration', () => {
  it('registers finance.reconcile with the router registry so the job is never dead-lettered as unknown', async () => {
    const registry = new QueueJobRegistry();
    const reconciler = { run: jest.fn().mockResolvedValue({ synced: 2 }) };
    const sched = new PaymentsReconcileScheduler({ enqueue: jest.fn() } as any, reconciler as any, registry);
    sched.onModuleInit();
    const entry = registry.get(QUEUE_AUTOMATION, RECONCILE_JOB);
    expect(entry).toBeDefined();
    await expect(entry!.handler({ name: RECONCILE_JOB } as any, undefined as any)).resolves.toEqual({ synced: 2 });
    expect(reconciler.run).toHaveBeenCalledTimes(1);
  });
});
