import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SocialSafetyService } from './social-safety.service';

const ME = 'me';

function makeService(
  opts: { userExists?: boolean; existingReport?: { id: string } | null } = {},
) {
  const exec = jest.fn().mockResolvedValue(undefined);
  const insertQb = {
    insert: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    execute: exec,
  };
  insertQb.insert.mockReturnValue(insertQb);
  insertQb.values.mockReturnValue(insertQb);
  insertQb.orIgnore.mockReturnValue(insertQb);
  const blocksRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(insertQb),
    delete: jest.fn(),
  };
  const reportsRepo = {
    findOne: jest.fn().mockResolvedValue(opts.existingReport ?? null),
    create: jest.fn((v) => v),
    save: jest.fn().mockResolvedValue({ id: 'r1' }),
  };
  const usersRepo = {
    exists: jest.fn().mockResolvedValue(opts.userExists ?? true),
  };
  const storiesRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 's1', author_id: ME }),
  };
  const service = new SocialSafetyService(
    blocksRepo as never,
    reportsRepo as never,
    usersRepo as never,
    storiesRepo as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    { findOne: jest.fn().mockResolvedValue(null) } as never,
  );
  return { service, blocksRepo, reportsRepo, insertQb };
}

describe('SocialSafetyService', () => {
  it('refuses to block yourself', async () => {
    await expect(makeService().service.block(ME, ME)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to block an unknown user', async () => {
    await expect(
      makeService({ userExists: false }).service.block(ME, 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('block is idempotent (insert or ignore)', async () => {
    const { service, insertQb } = makeService();
    await service.block(ME, 'x');
    expect(insertQb.values).toHaveBeenCalledWith({
      blocker_id: ME,
      blocked_id: 'x',
    });
    expect(insertQb.orIgnore).toHaveBeenCalled();
  });

  it('unblock deletes the row', async () => {
    const { service, blocksRepo } = makeService();
    await service.unblock(ME, 'x');
    expect(blocksRepo.delete).toHaveBeenCalledWith({
      blocker_id: ME,
      blocked_id: 'x',
    });
  });

  it('creates a report and caps the reason at 500 chars', async () => {
    const { service, reportsRepo } = makeService();
    await expect(
      service.createReport(ME, {
        targetType: 'user',
        targetId: 'u2',
        reason: 'x'.repeat(600),
      }),
    ).resolves.toEqual({ id: 'r1' });
    expect(reportsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'x'.repeat(500) }),
    );
  });

  it('returns the existing open report instead of duplicating', async () => {
    const { service, reportsRepo } = makeService({
      existingReport: { id: 'old' },
    });
    await expect(
      service.createReport(ME, {
        targetType: 'user',
        targetId: 'u2',
        reason: 'spam',
      }),
    ).resolves.toEqual({
      id: 'old',
    });
    expect(reportsRepo.save).not.toHaveBeenCalled();
  });

  it('404s for a missing target and rejects self-reports', async () => {
    await expect(
      makeService({ userExists: false }).service.createReport(ME, {
        targetType: 'user',
        targetId: 'u2',
        reason: 'a',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      makeService().service.createReport(ME, {
        targetType: 'story',
        targetId: 's1',
        reason: 'a',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
