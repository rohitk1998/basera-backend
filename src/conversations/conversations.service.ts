import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CallEntity,
  ConversationEntity,
  ConversationPresenceEntity,
  ListingEntity,
  MessageEntity,
  ProfileEntity,
} from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { StartCallDto } from './dto/start-call.dto';
import { UpdateCallDto } from './dto/update-call.dto';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(CallEntity)
    private readonly calls: Repository<CallEntity>,
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    @InjectRepository(ProfileEntity)
    private readonly profiles: Repository<ProfileEntity>,
    @InjectRepository(ConversationPresenceEntity)
    private readonly presence: Repository<ConversationPresenceEntity>,
    private readonly notifications: NotificationsService,
  ) {}

  /** Not Realtime Presence — see conversation-presence.entity.ts. Called
   *  by the client every ~15s while the thread is open and the tab is
   *  foregrounded; multiple tabs for the same user coalesce onto the same
   *  row via the composite primary key. */
  async heartbeat(userId: string, conversationId: string): Promise<void> {
    await this.requireParticipant(userId, conversationId);
    await this.presence.upsert(
      { user_id: userId, conversation_id: conversationId, last_seen_at: new Date() },
      ['user_id', 'conversation_id'],
    );
  }

  /** True if the given user heartbeated on this conversation within the
   *  last 30s — recent enough that they're almost certainly still looking
   *  at the live-updating thread, so a push/email would just be noise. */
  private async isRecentlyPresent(userId: string, conversationId: string): Promise<boolean> {
    const row = await this.presence.findOne({ where: { user_id: userId, conversation_id: conversationId } });
    if (!row) return false;
    return Date.now() - row.last_seen_at.getTime() < 30_000;
  }

  /**
   * The caller's own conversations, as guest or host, newest activity
   * first. Joined with listing title and the other party's name here
   * rather than left to the browser, since that needs a cross-table read
   * RLS alone can't cheaply express.
   */
  async list(userId: string) {
    const rows = await this.conversations.find({
      where: [{ guest_id: userId }, { host_id: userId }],
      order: { last_message_at: 'DESC' },
    });

    const listingIds = [...new Set(rows.map((r) => r.listing_id))];
    const otherPartyIds = [
      ...new Set(rows.map((r) => (r.guest_id === userId ? r.host_id : r.guest_id))),
    ];

    const [listingRows, profileRows]: [Pick<ListingEntity, 'id' | 'draft_data'>[], Pick<ProfileEntity, 'id' | 'full_name'>[]] =
      await Promise.all([
        listingIds.length
          ? this.listings.find({ where: listingIds.map((id) => ({ id })), select: { id: true, draft_data: true } })
          : Promise.resolve([]),
        otherPartyIds.length
          ? this.profiles.find({ where: otherPartyIds.map((id) => ({ id })), select: { id: true, full_name: true } })
          : Promise.resolve([]),
      ]);
    const listingById = new Map(listingRows.map((l): [string, Pick<ListingEntity, 'id' | 'draft_data'>] => [l.id, l]));
    const nameById = new Map(profileRows.map((p): [string, string | null] => [p.id, p.full_name]));

    return rows.map((r) => {
      const draft = (listingById.get(r.listing_id)?.draft_data as Record<string, any>) ?? {};
      const otherPartyId = r.guest_id === userId ? r.host_id : r.guest_id;
      return {
        id: r.id,
        listingId: r.listing_id,
        listingTitle: draft.property_details?.title ?? 'Listing',
        otherPartyName: nameById.get(otherPartyId) ?? 'Basera user',
        role: r.guest_id === userId ? ('guest' as const) : ('host' as const),
        lastMessageAt: r.last_message_at,
      };
    });
  }

  /** Idempotent get-or-create, keyed on (listing_id, guest_id). The caller
   *  is always the guest here — a host never creates a conversation this
   *  way, they only reply within one a guest already started. */
  async getOrCreate(userId: string, dto: CreateConversationDto) {
    const listing = await this.listings.findOne({
      where: { id: dto.listingId },
      select: { id: true, host_id: true },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.host_id === userId) {
      throw new BadRequestException('You cannot message yourself about your own listing.');
    }

    const existing = await this.conversations.findOne({
      where: { listing_id: dto.listingId, guest_id: userId },
    });
    if (existing) {
      return existing;
    }

    const created = this.conversations.create({
      listing_id: dto.listingId,
      guest_id: userId,
      host_id: listing.host_id,
    });
    return this.conversations.save(created);
  }

  private async requireParticipant(userId: string, conversationId: string): Promise<ConversationEntity> {
    const conversation = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.guest_id !== userId && conversation.host_id !== userId) {
      throw new ForbiddenException('Not a participant in this conversation.');
    }
    return conversation;
  }

  /**
   * The only write path for messages — see the entity's comment. Bumps
   * last_message_at so the conversation list re-sorts, then notifies the
   * other party via the pre-existing 'message.received' event/copy/email
   * template (see notifications.types.ts / notification-copy-catalog.ts /
   * email-templates.ts — already built for exactly this, never used
   * until now).
   */
  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    const conversation = await this.requireParticipant(userId, conversationId);

    const message = this.messages.create({
      conversation_id: conversationId,
      sender_id: userId,
      body: dto.body,
    });
    const saved = await this.messages.save(message);

    await this.conversations.update({ id: conversationId }, { last_message_at: saved.created_at });

    const otherPartyId = conversation.guest_id === userId ? conversation.host_id : conversation.guest_id;

    // Skip the notification if the recipient is right here — they'll see
    // this message land live via their own Realtime subscription, so a
    // push/email would just be a redundant nag about something already
    // on their screen.
    const recipientIsHere = await this.isRecentlyPresent(otherPartyId, conversationId);
    if (!recipientIsHere) {
      const sender = await this.profiles.findOne({ where: { id: userId }, select: { full_name: true } });
      this.notifications.notify('message.received', otherPartyId, {
        senderName: sender?.full_name ?? 'Someone',
        link: `/messages/${conversationId}`,
        pushTitle: 'New message',
        pushBody: `${sender?.full_name ?? 'Someone'} sent you a message`,
      });
    }

    return { success: true, id: saved.id };
  }

  /** Creates the ring/missed-call history row and notifies the callee —
   *  the actual audio/video never touches this service; see CallModal on
   *  the frontend for the WebRTC signaling, which happens entirely over
   *  an ephemeral Realtime broadcast channel this row has no part in. */
  async startCall(userId: string, conversationId: string, dto: StartCallDto) {
    const conversation = await this.requireParticipant(userId, conversationId);
    const calleeId = conversation.guest_id === userId ? conversation.host_id : conversation.guest_id;

    const call = this.calls.create({
      conversation_id: conversationId,
      caller_id: userId,
      callee_id: calleeId,
      kind: dto.kind,
      status: 'ringing',
    });
    const saved = await this.calls.save(call);

    const caller = await this.profiles.findOne({ where: { id: userId }, select: { full_name: true } });
    this.notifications.notify('call.incoming', calleeId, {
      senderName: caller?.full_name ?? 'Someone',
      link: `/messages/${conversationId}`,
      pushTitle: 'Incoming call',
      pushBody: `${caller?.full_name ?? 'Someone'} is calling you on Basera`,
    });

    return { success: true, id: saved.id, kind: saved.kind, status: saved.status };
  }

  async updateCall(userId: string, conversationId: string, callId: string, dto: UpdateCallDto) {
    await this.requireParticipant(userId, conversationId);

    const call = await this.calls.findOne({ where: { id: callId, conversation_id: conversationId } });
    if (!call) {
      throw new NotFoundException('Call not found');
    }
    if (call.caller_id !== userId && call.callee_id !== userId) {
      throw new ForbiddenException('Not a participant in this call.');
    }

    const ended = dto.status === 'declined' || dto.status === 'missed' || dto.status === 'ended';
    await this.calls.update(
      { id: callId },
      { status: dto.status, ended_at: ended ? new Date() : call.ended_at },
    );

    return { success: true };
  }
}
