import { Logger } from '@nestjs/common';
import { UserService } from './user.service';

const SQL = 'update users set welcome_seen_at = now() where id = $1 and welcome_seen_at is null';

function makeService(query: jest.Mock) {
  const profiles = { manager: { query } };
  return new UserService(profiles as never, {} as never, {} as never);
}

describe('UserService.markWelcomeSeen', () => {
  afterEach(() => jest.restoreAllMocks());

  it('updates once with a bound userId parameter', async () => {
    const query = jest.fn().mockResolvedValue([[], 1]);
    const res = await makeService(query).markWelcomeSeen("u1'; drop table users;--");
    expect(res).toEqual({ success: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(SQL, ["u1'; drop table users;--"]);
    expect(query.mock.calls[0][0]).not.toContain('u1');
  });

  it('second call is a no-op that still returns success', async () => {
    const query = jest.fn().mockResolvedValueOnce([[], 1]).mockResolvedValueOnce([[], 0]);
    const service = makeService(query);
    await service.markWelcomeSeen('u1');
    await expect(service.markWelcomeSeen('u1')).resolves.toEqual({ success: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('swallows a missing-column error (42703) and warns once', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const query = jest.fn().mockRejectedValue({ driverError: { code: '42703' } });
    const service = makeService(query);
    await expect(service.markWelcomeSeen('u1')).resolves.toEqual({ success: true });
    await expect(service.markWelcomeSeen('u1')).resolves.toEqual({ success: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rethrows other database errors', async () => {
    const query = jest.fn().mockRejectedValue({ code: '08006' });
    await expect(makeService(query).markWelcomeSeen('u1')).rejects.toEqual({ code: '08006' });
  });
});

describe('UserService.getProfile welcomeSeenAt', () => {
  const SELECT = 'select welcome_seen_at from users where id = $1';
  const row = { id: 'u1', languages: [], created_at: null };

  function make(query: jest.Mock) {
    const profiles = { findOne: jest.fn().mockResolvedValue(row), manager: { query } };
    const verifs = { findOne: jest.fn().mockResolvedValue(null) };
    return new UserService(profiles as never, verifs as never, {} as never);
  }

  it('returns explicit null when never seen', async () => {
    const query = jest.fn().mockResolvedValue([{ welcome_seen_at: null }]);
    const res = await make(query).getProfile('u1');
    expect(query).toHaveBeenCalledWith(SELECT, ['u1']);
    expect(res.profile).toHaveProperty('welcomeSeenAt', null);
  });

  it('returns an ISO string when seen', async () => {
    const query = jest.fn().mockResolvedValue([{ welcome_seen_at: new Date('2026-10-14T01:02:03.000Z') }]);
    const res = await make(query).getProfile('u1');
    expect(res.profile.welcomeSeenAt).toBe('2026-10-14T01:02:03.000Z');
  });

  it('omits the field when the column is missing (42703)', async () => {
    const query = jest.fn().mockRejectedValue({ driverError: { code: '42703' } });
    const res = await make(query).getProfile('u1');
    expect(res.profile).not.toHaveProperty('welcomeSeenAt');
  });

  it('rethrows other database errors', async () => {
    const query = jest.fn().mockRejectedValue({ code: '08006' });
    await expect(make(query).getProfile('u1')).rejects.toEqual({ code: '08006' });
  });
});
