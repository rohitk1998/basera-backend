import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StayChatService } from './stay-chat.service';

function makeService(eligible = true) {
  const messages = {
    create: jest.fn((v) => v),
    save: jest.fn(async (v) => ({
      id: 'x',
      created_at: new Date('2026-01-01T00:00:00Z'),
      ...v,
    })),
    find: jest.fn().mockResolvedValue([]),
  };
  const users = {
    find: jest.fn().mockResolvedValue([{ id: 'u1', full_name: 'Asha Rao' }]),
  };
  const access = {
    assertGuestOfListing: eligible
      ? jest.fn().mockResolvedValue(undefined)
      : jest.fn().mockRejectedValue(new ForbiddenException()),
    earliestStayStart: jest.fn().mockResolvedValue(new Date('2026-01-01')),
  };
  const safety = { blockedIdsFor: jest.fn().mockResolvedValue([]) };
  const service = new StayChatService(
    messages as never,
    users as never,
    access as never,
    safety as never,
  );
  return { service, messages };
}

describe('StayChatService', () => {
  it('trims the body and returns the first name', async () => {
    const { service, messages } = makeService();
    const dto = await service.post('u1', 'l1', '  hello  ');
    expect(messages.save).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'hello' }),
    );
    expect(dto.senderFirstName).toBe('Asha');
  });

  it('rejects empty and oversized messages', async () => {
    const { service } = makeService();
    await expect(service.post('u1', 'l1', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.post('u1', 'l1', 'a'.repeat(1001)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks non-eligible users from reading and writing', async () => {
    const { service } = makeService(false);
    await expect(service.list('u1', 'l1', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.post('u1', 'l1', 'hi')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('pages with a cursor when more rows exist', async () => {
    const { service, messages } = makeService();
    const row = (i: number) => ({
      id: `m${i}`,
      sender_id: 'u1',
      body: 'b',
      created_at: new Date(2026, 0, 10 - i),
    });
    messages.find.mockResolvedValue([row(0), row(1), row(2)]);
    const page = await service.list('u1', 'l1', { limit: 2 });
    expect(page.messages).toHaveLength(2);
    expect(page.nextCursor).toBe(row(1).created_at.toISOString());
  });
});
