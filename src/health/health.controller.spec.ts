import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const make = (query: jest.Mock, set: jest.Mock) =>
    new HealthController({ query } as any, { set } as any);

  it('live returns only {status}', () => {
    expect(make(jest.fn(), jest.fn()).live()).toEqual({ status: 'ok' });
  });

  it('ready is ok when db and redis answer', async () => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    await expect(make(query, jest.fn().mockResolvedValue(true)).ready()).resolves.toEqual({ status: 'ok' });
    expect(query).toHaveBeenCalledWith('select 1');
  });

  it('ready is 503 with no detail when the db fails', async () => {
    const c = make(jest.fn().mockRejectedValue(new Error('secret host')), jest.fn().mockResolvedValue(true));
    await expect(c.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await c.ready().catch((e) => expect(e.getResponse()).toEqual({ status: 'unavailable' }));
  });

  it('ready is 503 when redis is unreachable', async () => {
    const c = make(jest.fn().mockResolvedValue([]), jest.fn().mockResolvedValue(false));
    await expect(c.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
