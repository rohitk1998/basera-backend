import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BookingEntity, GuestProfileEntity, UserEntity } from '../entities';
import {
  SocialAccessService,
  SOCIAL_ELIGIBLE_BOOKING_STATUSES,
  applyInProgressWindow,
} from './social-access.service';
import { toFirstName, isUuid } from './social-name.util';
import type {
  GuestCardDto,
  GuestProfileDto,
  ListingSummaryDto,
} from './dto/guest-profile.dto';
import type { UpdateGuestProfileDto } from './dto/update-guest-profile.dto';

const GUESTS_LIST_LIMIT = 100;

@Injectable()
export class GuestProfileService {
  constructor(
    @InjectRepository(GuestProfileEntity)
    private readonly profilesRepo: Repository<GuestProfileEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepo: Repository<UserEntity>,
    @InjectRepository(BookingEntity)
    private readonly bookingsRepo: Repository<BookingEntity>,
    private readonly access: SocialAccessService,
  ) {}

  async getProfile(userId: string): Promise<GuestProfileDto> {
    const row = await this.profilesRepo.findOne({ where: { user_id: userId } });
    return toProfileDto(row);
  }

  async updateProfile(
    userId: string,
    dto: UpdateGuestProfileDto,
  ): Promise<GuestProfileDto> {
    const values = {
      user_id: userId,
      visible: dto.visible,
      headline: dto.headline ?? null,
      home_country: dto.homeCountry ?? null,
      work_status: dto.workStatus ?? null,
      updated_at: new Date(),
    };
    await this.profilesRepo.upsert(values, ['user_id']);
    return toProfileDto(values);
  }

  /** Public: a bare count of opted-in guests with a stay at the listing. No identities. */
  async getListingSummary(listingId: string): Promise<ListingSummaryDto> {
    if (!isUuid(listingId)) return { guestsHereCount: 0 };
    const guestsHereCount = await this.profilesRepo
      .createQueryBuilder('p')
      .where('p.visible = true')
      .andWhere((qb) => {
        const subQb = qb
          .subQuery()
          .select('1')
          .from(BookingEntity, 'b')
          .where('b.guest_id = p.user_id AND b.listing_id = :listingId')
          .andWhere('b.status IN (:...statuses)');
        const sub = applyInProgressWindow(subQb, 'b').getQuery();
        return `EXISTS ${sub}`;
      })
      .setParameters({ listingId, statuses: SOCIAL_ELIGIBLE_BOOKING_STATUSES })
      .getCount();
    return { guestsHereCount };
  }

  /** Guests-only list of opted-in guests. First name plus optional profile fields; nothing else. */
  async listGuests(
    requesterId: string,
    listingId: string,
  ): Promise<{ count: number; guests: GuestCardDto[] }> {
    await this.access.assertGuestOfListing(requesterId, listingId);
    const ids = await this.access.listEligibleGuestIds(listingId, requesterId);
    if (ids.length === 0) return { count: 0, guests: [] };

    const profiles = await this.profilesRepo
      .createQueryBuilder('p')
      .where('p.user_id IN (:...ids) AND p.visible = true', { ids })
      .orderBy('p.updated_at', 'DESC')
      .limit(GUESTS_LIST_LIMIT)
      .getMany();
    if (profiles.length === 0) return { count: 0, guests: [] };

    const users = await this.usersRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.full_name', 'u.avatar_url'])
      .where('u.id IN (:...ids)', { ids: profiles.map((p) => p.user_id) })
      .getMany();
    const byId = new Map(users.map((u) => [u.id, u]));

    const guests = profiles.flatMap((p): GuestCardDto[] => {
      const user = byId.get(p.user_id);
      if (!user) return [];
      return [
        {
          userId: p.user_id,
          firstName: toFirstName(user.full_name),
          avatarUrl: user.avatar_url ?? null,
          headline: p.headline ?? null,
          homeCountry: p.home_country ?? null,
          workStatus: p.work_status ?? null,
        },
      ];
    });
    return { count: guests.length, guests };
  }
}

function toProfileDto(
  row: Pick<
    GuestProfileEntity,
    'visible' | 'headline' | 'home_country' | 'work_status'
  > | null,
): GuestProfileDto {
  return {
    visible: row?.visible ?? false,
    headline: row?.headline ?? null,
    homeCountry: row?.home_country ?? null,
    workStatus: row?.work_status ?? null,
  };
}
