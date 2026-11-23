import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';

function build() {
  const repo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn(async (x) => x), create: jest.fn((x) => x), update: jest.fn() });
  const conversations = repo();
  const messages = repo();
  const listings = repo();
  const profiles = repo();
  const presence = repo();
  const notifications = { notify: jest.fn() };
  const svc = new ConversationsService(conversations as any, messages as any, repo() as any, listings as any, profiles as any, presence as any, notifications as any);
  return { svc, conversations, messages, listings, profiles, presence };
}

describe('ConversationsService listing gating', () => {
  it('creates a conversation for a live listing', async () => {
    const { svc, listings, conversations } = build();
    listings.findOne.mockResolvedValue({ id: 'l1', host_id: 'h', status: 'live', is_discovered: false });
    conversations.findOne.mockResolvedValue(null);
    await svc.getOrCreate('g', { listingId: 'l1' } as any);
    expect(conversations.save).toHaveBeenCalled();
  });

  it.each([
    ['non-live', { status: 'draft', is_discovered: false }],
    ['discovered', { status: 'live', is_discovered: true }],
  ])('rejects getOrCreate on %s listing', async (_n, extra) => {
    const { svc, listings, conversations } = build();
    listings.findOne.mockResolvedValue({ id: 'l1', host_id: 'h', ...extra });
    await expect(svc.getOrCreate('g', { listingId: 'l1' } as any)).rejects.toThrow(NotFoundException);
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('still blocks messaging own listing', async () => {
    const { svc, listings } = build();
    listings.findOne.mockResolvedValue({ id: 'l1', host_id: 'g', status: 'live' });
    await expect(svc.getOrCreate('g', { listingId: 'l1' } as any)).rejects.toThrow(BadRequestException);
  });

  it('sendMessage fails when listing is no longer live, passes when live', async () => {
    const { svc, listings, conversations, messages, presence, profiles } = build();
    conversations.findOne.mockResolvedValue({ id: 'c1', listing_id: 'l1', guest_id: 'g', host_id: 'h' });
    listings.findOne.mockResolvedValueOnce({ id: 'l1', status: 'archived' });
    await expect(svc.sendMessage('g', 'c1', { body: 'hi' } as any)).rejects.toThrow(NotFoundException);
    expect(messages.save).not.toHaveBeenCalled();

    listings.findOne.mockResolvedValueOnce({ id: 'l1', status: 'live', is_discovered: false });
    messages.save.mockResolvedValue({ id: 'm1', created_at: new Date() });
    presence.findOne.mockResolvedValue(null);
    profiles.findOne.mockResolvedValue({ full_name: 'G' });
    await expect(svc.sendMessage('g', 'c1', { body: 'hi' } as any)).resolves.toEqual({ success: true, id: 'm1' });
  });
});
