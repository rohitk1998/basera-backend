import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, MoreThanOrEqual, Not, Repository } from 'typeorm';
import {
  ListingEntity,
  MeetupEntity,
  MeetupMemberEntity,
  UserEntity,
} from '../entities';
import { SocialAccessService } from './social-access.service';
import { SocialSafetyService } from './social-safety.service';
import { rowToListing } from '../listings/listing-mapper';
import { firstNameOf } from './stay-chat.service';
import type { CreateMeetupDto } from './dto/meetup-create.dto';

export type MeetupDto = {
  id: string;
  title: string;
  description: string;
  town: string;
  startsAt: string;
  placeText: string;
  capacity: number | null;
  goingCount: number;
  joined: boolean;
  hostFirstName: string;
  listingId: string | null;
  eventId: string | null;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_DAYS_AHEAD = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MeetupsService {
  constructor(
    @InjectRepository(MeetupEntity)
    private readonly meetups: Repository<MeetupEntity>,
    @InjectRepository(MeetupMemberEntity)
    private readonly members: Repository<MeetupMemberEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(ListingEntity)
    private readonly listings: Repository<ListingEntity>,
    private readonly dataSource: DataSource,
    private readonly access: SocialAccessService,
    private readonly safety: SocialSafetyService,
  ) {}

  async list(
    query: { listingId?: string; town?: string; limit?: number },
    viewerId?: string,
  ): Promise<MeetupDto[]> {
    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const blocked = viewerId ? await this.safety.blockedIdsFor(viewerId) : [];

    const rows = await this.meetups.find({
      where: {
        status: 'open',
        starts_at: MoreThanOrEqual(new Date()),
        ...(query.listingId ? { listing_id: query.listingId } : {}),
        ...(query.town ? { town: query.town } : {}),
        ...(blocked.length ? { host_user_id: Not(In(blocked)) } : {}),
      },
      order: { starts_at: 'ASC' },
      take: limit,
    });
    const dtos = await this.toDtos(rows, viewerId);
    return this.redactStayMeetups(dtos, viewerId);
  }

  /** Stay-scoped meetups hide place and host from anyone who is not a current guest of that stay. */
  private async redactStayMeetups(
    dtos: MeetupDto[],
    viewerId?: string,
  ): Promise<MeetupDto[]> {
    const listingIds = [
      ...new Set(
        dtos.map((d) => d.listingId).filter((id): id is string => !!id),
      ),
    ];
    if (!listingIds.length) return dtos;
    const allowed = new Set<string>();
    if (viewerId) {
      await Promise.all(
        listingIds.map((id) =>
          this.access
            .assertGuestOfListing(viewerId, id)
            .then(() => void allowed.add(id))
            .catch((err: unknown) => {
              if (!(err instanceof ForbiddenException)) throw err;
            }),
        ),
      );
    }
    return dtos.map((d) =>
      d.listingId && !allowed.has(d.listingId)
        ? { ...d, placeText: '', hostFirstName: '' }
        : d,
    );
  }

  async create(userId: string, dto: CreateMeetupDto): Promise<MeetupDto> {
    const startsAt = new Date(dto.startsAt);
    const now = Date.now();
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= now) {
      throw new BadRequestException('Meetup start time must be in the future.');
    }
    if (startsAt.getTime() > now + MAX_DAYS_AHEAD * DAY_MS) {
      throw new BadRequestException(
        `Meetups can be scheduled up to ${MAX_DAYS_AHEAD} days ahead.`,
      );
    }
    const capacity = dto.capacity ?? null;
    if (capacity !== null && (capacity < 2 || capacity > 50)) {
      throw new BadRequestException('Capacity must be between 2 and 50.');
    }

    let town = dto.town?.trim() ?? '';
    const listingId = dto.listingId ?? null;
    if (listingId) {
      await this.access.assertGuestOfListing(userId, listingId);
      const listing = await this.listings.findOne({ where: { id: listingId } });
      if (!listing) throw new NotFoundException('Listing not found.');
      town = rowToListing(listing).town || town;
    }
    if (!town) throw new BadRequestException('Town is required.');

    const meetup = await this.dataSource.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(MeetupEntity, {
          host_user_id: userId,
          listing_id: listingId,
          event_id: dto.eventId ?? null,
          town,
          title: dto.title.trim(),
          description: dto.description.trim(),
          starts_at: startsAt,
          place_text: dto.placeText.trim(),
          capacity,
          status: 'open',
        }),
      );
      await manager.insert(MeetupMemberEntity, {
        meetup_id: created.id,
        user_id: userId,
      });
      return created;
    });
    return this.one(meetup.id, userId);
  }

  async join(userId: string, meetupId: string): Promise<MeetupDto> {
    const preview = await this.meetups.findOne({ where: { id: meetupId } });
    if (!preview) throw new NotFoundException('Meetup not found.');
    if (preview.listing_id)
      await this.access.assertGuestOfListing(userId, preview.listing_id);
    if (
      (await this.safety.blockedIdsFor(userId)).includes(preview.host_user_id)
    ) {
      throw new ForbiddenException('You cannot join this meetup.');
    }

    await this.dataSource.transaction(async (manager) => {
      // Row lock serialises concurrent joins so capacity cannot be exceeded.
      const meetup = await manager.findOne(MeetupEntity, {
        where: { id: meetupId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!meetup) throw new NotFoundException('Meetup not found.');
      if (meetup.status !== 'open')
        throw new ConflictException('This meetup was cancelled.');
      if (meetup.starts_at.getTime() <= Date.now())
        throw new ConflictException('This meetup has already started.');

      const already = await manager.exists(MeetupMemberEntity, {
        where: { meetup_id: meetupId, user_id: userId },
      });
      if (already) return;
      if (meetup.capacity !== null) {
        const going = await manager.count(MeetupMemberEntity, {
          where: { meetup_id: meetupId },
        });
        if (going >= meetup.capacity)
          throw new ConflictException('This meetup is full.');
      }
      await manager.insert(MeetupMemberEntity, {
        meetup_id: meetupId,
        user_id: userId,
      });
    });
    return this.one(meetupId, userId);
  }

  async leave(userId: string, meetupId: string): Promise<MeetupDto> {
    const meetup = await this.meetups.findOne({ where: { id: meetupId } });
    if (!meetup) throw new NotFoundException('Meetup not found.');
    if (meetup.host_user_id === userId) {
      throw new BadRequestException(
        'You are hosting this meetup, so you cannot leave it.',
      );
    }
    // Leaving never requires eligibility: someone who lost access can still drop out.
    await this.members.delete({ meetup_id: meetupId, user_id: userId });
    return this.one(meetupId, userId);
  }

  private async one(meetupId: string, viewerId: string): Promise<MeetupDto> {
    const row = await this.meetups.findOneOrFail({ where: { id: meetupId } });
    const [dto] = await this.toDtos([row], viewerId);
    return dto;
  }

  private async toDtos(
    rows: MeetupEntity[],
    viewerId?: string,
  ): Promise<MeetupDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [counts, mine, hosts] = await Promise.all([
      this.members
        .createQueryBuilder('m')
        .select('m.meetup_id', 'meetupId')
        .addSelect('COUNT(*)', 'n')
        .where('m.meetup_id IN (:...ids)', { ids })
        .groupBy('m.meetup_id')
        .getRawMany<{ meetupId: string; n: string }>(),
      viewerId
        ? this.members.find({
            where: { meetup_id: In(ids), user_id: viewerId },
          })
        : Promise.resolve([] as MeetupMemberEntity[]),
      this.users.find({
        where: { id: In([...new Set(rows.map((r) => r.host_user_id))]) },
        select: { id: true, full_name: true },
      }),
    ]);
    const goingById = new Map(counts.map((c) => [c.meetupId, Number(c.n)]));
    const joinedIds = new Set(mine.map((m) => m.meetup_id));
    const hostNames = new Map(
      hosts.map((h) => [h.id, firstNameOf(h.full_name)]),
    );

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      town: r.town,
      startsAt: r.starts_at.toISOString(),
      placeText: r.place_text,
      capacity: r.capacity,
      goingCount: goingById.get(r.id) ?? 0,
      joined: joinedIds.has(r.id),
      hostFirstName: hostNames.get(r.host_user_id) ?? 'Guest',
      listingId: r.listing_id,
      eventId: r.event_id,
    }));
  }
}
