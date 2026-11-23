import { BookingEntity, BookingEventEntity } from '../entities';

type Repo = Record<string, jest.Mock>;

/**
 * Minimal DataSource double for BookingsService specs: transaction() runs the
 * callback against a manager whose update()/getRepository() route to the
 * repository mocks the test supplied (keyed by entity class), so assertions on
 * e.g. bookingsRepo.update still see status changes made inside a transaction.
 */
export function fakeDataSource(
  repos: Map<unknown, Repo> = new Map(),
  query: jest.Mock = jest.fn().mockResolvedValue([]),
) {
  const eventsRepo: Repo = { insert: jest.fn().mockResolvedValue(undefined) };
  if (!repos.has(BookingEventEntity)) repos.set(BookingEventEntity, eventsRepo);
  const missing = () => ({
    insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'x' }] }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  });
  const manager = {
    update: jest.fn((entity: unknown, where: unknown, set: unknown) =>
      (repos.get(entity) ?? missing()).update(where, set),
    ),
    getRepository: jest.fn((entity: unknown) => repos.get(entity) ?? missing()),
    query,
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
    query,
    manager,
  };
  return { dataSource, manager, query, events: repos.get(BookingEventEntity)! };
}

export { BookingEntity };
