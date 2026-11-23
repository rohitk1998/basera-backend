import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListingEntity } from '../entities';
import { PropertyMemberEntity } from './claims.entities';

/**
 * Single permission check for "may this user manage this property?": the listing's host_id,
 * or a non-revoked property_members row (owner|manager). Exported for the listings module.
 * Discovered (unclaimed) rows have host_id NULL and no members, so nobody can manage them.
 */
@Injectable()
export class PropertyAccess {
  constructor(
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    @InjectRepository(PropertyMemberEntity) private readonly members: Repository<PropertyMemberEntity>,
  ) {}

  async canManage(userId: string, listingId: string): Promise<boolean> {
    if (!userId || !listingId) return false;
    const listing = await this.listings.findOne({ where: { id: listingId }, select: { id: true, host_id: true, is_discovered: true } });
    if (!listing) return false;
    if (listing.host_id && listing.host_id === userId) return true;
    const m = await this.members
      .createQueryBuilder('m')
      .where('m.listing_id = :listingId AND m.user_id = :userId AND m.revoked_at IS NULL', { listingId, userId })
      .getCount();
    return m > 0;
  }
}
