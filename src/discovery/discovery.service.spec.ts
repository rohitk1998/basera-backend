import { BadRequestException, ConflictException } from '@nestjs/common';
import { canTransition, DISCOVERY_STATES, TRANSITIONS } from './discovery.constants';
import { DiscoveryService, validCron } from './discovery.service';

const svcWith = (state: string) => {
  const ds = { query: jest.fn(async (sql: string) => (/^\s*UPDATE/.test(sql) ? [{ id: 'x' }] : [{ id: 'x', discovery_state: state }])) };
  const redis = { incrementVersion: jest.fn(async () => 2) };
  return { svc: new DiscoveryService(ds as any, { enqueue: jest.fn() } as any, {} as any, {} as any, redis as any), ds, redis };
};

describe('transition matrix', () => {
  it('allows the documented moves and nothing else', () => {
    expect(canTransition('DISCOVERED', 'REVIEW_PENDING')).toBe(true);
    expect(canTransition('DISCOVERED', 'HOST_INTERESTED')).toBe(false);
    expect(canTransition('ARCHIVED', 'DISCOVERED')).toBe(true);
    expect(canTransition('CONVERTED_TO_PROPERTY', 'ARCHIVED')).toBe(false);
    expect(canTransition('NOPE', 'ARCHIVED')).toBe(false);
  });
  it('is total, self-loop free and only targets known states', () => {
    for (const s of DISCOVERY_STATES) {
      expect(TRANSITIONS[s]).not.toContain(s);
      TRANSITIONS[s].forEach((t) => expect(DISCOVERY_STATES).toContain(t));
    }
  });
});

describe('DiscoveryService.transition', () => {
  it('applies a valid move with an optimistic state guard', async () => {
    const { svc, ds } = svcWith('DISCOVERED');
    await svc.transition('x', 'REVIEW_PENDING', 'admin');
    const upd = ds.query.mock.calls.find((c) => /UPDATE listings/.test(c[0] as string))!;
    expect(upd[0]).toMatch(/discovery_state=\$3/);
  });
  it('bumps the search cache version when a candidate leaves the public grid', async () => {
    const a = svcWith('DISCOVERED');
    await a.svc.transition('x', 'ARCHIVED', 'admin');
    expect(a.redis.incrementVersion).toHaveBeenCalledWith('listings:search:version');
    const b = svcWith('HOST_INTERESTED');
    await b.svc.transition('x', 'HOST_DECLINED', 'admin');
    expect(b.redis.incrementVersion).toHaveBeenCalledTimes(1);
  });
  it('does not bump for a move that stays on the grid, and survives a redis failure', async () => {
    const a = svcWith('DISCOVERED');
    await a.svc.transition('x', 'REVIEW_PENDING', 'admin');
    expect(a.redis.incrementVersion).not.toHaveBeenCalled();
    const b = svcWith('DISCOVERED');
    b.redis.incrementVersion.mockRejectedValueOnce(new Error('redis down'));
    await expect(b.svc.transition('x', 'ARCHIVED', 'admin')).resolves.toBeDefined();
  });
  it('rejects an invalid move with 409', async () => {
    await expect(svcWith('DISCOVERED').svc.transition('x', 'HOST_INTERESTED', 'a')).rejects.toThrow(ConflictException);
  });
  it('never lets staff set CONVERTED_TO_PROPERTY by hand', async () => {
    await expect(svcWith('HOST_INTERESTED').svc.transition('x', 'CONVERTED_TO_PROPERTY', 'a')).rejects.toThrow(BadRequestException);
  });
  it('rejects unknown states', async () => {
    await expect(svcWith('DISCOVERED').svc.transition('x', 'WHATEVER', 'a')).rejects.toThrow(BadRequestException);
  });
});

describe('validCron', () => {
  it('accepts 5-field expressions only', () => {
    expect(validCron('0 3 * * *')).toBe(true);
    expect(validCron('nonsense')).toBe(false);
    expect(validCron('0 0 3 * * *')).toBe(false);
  });
});
