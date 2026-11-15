import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, In, LessThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { StayChatMessageEntity, UserEntity } from '../entities';
import { SocialAccessService } from './social-access.service';
import { SocialSafetyService } from './social-safety.service';

export type ChatMessageDto = {
  id: string;
  senderId: string;
  senderFirstName: string;
  body: string;
  createdAt: string;
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const MAX_BODY = 1000;

export function firstNameOf(fullName: string | null | undefined): string {
  return fullName?.trim().split(/\s+/)[0] || 'Guest';
}

@Injectable()
export class StayChatService {
  constructor(
    @InjectRepository(StayChatMessageEntity)
    private readonly messages: Repository<StayChatMessageEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly access: SocialAccessService,
    private readonly safety: SocialSafetyService,
  ) {}

  /** Newest first. Pass the createdAt of the oldest loaded message as `before` for the next page. */
  async list(
    userId: string,
    listingId: string,
    query: { before?: string; limit?: number },
  ) {
    await this.access.assertGuestOfListing(userId, listingId);
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const blocked = await this.safety.blockedIdsFor(userId);
    // A guest only sees messages posted since their current stay began (move-in day, India time).
    const since = await this.access.earliestStayStart(userId, listingId);
    if (!since) return { messages: [], nextCursor: null };

    const rows = await this.messages.find({
      where: {
        listing_id: listingId,
        created_at: query.before
          ? And(MoreThanOrEqual(since), LessThan(new Date(query.before)))
          : MoreThanOrEqual(since),
        ...(blocked.length ? { sender_id: Not(In(blocked)) } : {}),
      },
      order: { created_at: 'DESC' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const messages = await this.toDtos(page);
    const last = page[page.length - 1];
    return {
      messages,
      nextCursor: hasMore && last ? last.created_at.toISOString() : null,
    };
  }

  async post(
    userId: string,
    listingId: string,
    rawBody: string,
  ): Promise<ChatMessageDto> {
    await this.access.assertGuestOfListing(userId, listingId);
    const body = (rawBody ?? '').trim();
    if (!body) throw new BadRequestException('Message cannot be empty.');
    if (body.length > MAX_BODY)
      throw new BadRequestException(
        `Message is limited to ${MAX_BODY} characters.`,
      );

    const saved = await this.messages.save(
      this.messages.create({ listing_id: listingId, sender_id: userId, body }),
    );
    const [dto] = await this.toDtos([saved]);
    return dto;
  }

  private async toDtos(
    rows: StayChatMessageEntity[],
  ): Promise<ChatMessageDto[]> {
    if (!rows.length) return [];
    const senderIds = [...new Set(rows.map((r) => r.sender_id))];
    const senders = await this.users.find({
      where: { id: In(senderIds) },
      select: { id: true, full_name: true },
    });
    const names = new Map(senders.map((u) => [u.id, firstNameOf(u.full_name)]));
    return rows.map((r) => ({
      id: r.id,
      senderId: r.sender_id,
      senderFirstName: names.get(r.sender_id) ?? 'Guest',
      body: r.body,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
