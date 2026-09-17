import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReviewEntity, BookingEntity, UserEntity } from '../entities';
import { CreateReviewDto } from './dto/create-review.dto';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(ReviewEntity)
    private readonly reviewsRepo: Repository<ReviewEntity>,
    @InjectRepository(BookingEntity)
    private readonly bookingsRepo: Repository<BookingEntity>,
    @InjectRepository(UserEntity)
    private readonly profilesRepo: Repository<UserEntity>,
  ) {}

  async createReview(userId: string, bookingId: string, dto: CreateReviewDto) {
    const booking = await this.bookingsRepo.findOne({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.status !== 'completed' && booking.status !== 'checked_out') {
      throw new BadRequestException('You can only review completed or checked out stays');
    }

    if (booking.guest_id !== userId && booking.host_id !== userId) {
      throw new ForbiddenException('You are not a party to this booking');
    }

    const isGuest = booking.guest_id === userId;
    const targetUserId = isGuest ? booking.host_id : booking.guest_id;
    const role = isGuest ? 'guest_reviewing_host' : 'host_reviewing_guest';

    const existing = await this.reviewsRepo.findOne({
      where: { booking_id: bookingId, author_id: userId },
    });

    if (existing) {
      throw new ConflictException('You have already reviewed this stay');
    }

    try {
      await this.reviewsRepo.insert({
        booking_id: bookingId,
        author_id: userId,
        target_user_id: targetUserId,
        listing_id: isGuest ? booking.listing_id : null,
        role,
        rating: dto.rating,
        content: dto.content,
      });
    } catch (err: any) {
      // Race: a double-submit (slow network, impatient double-tap) or a
      // retried request lands here between the findOne check above and
      // this insert. The DB unique constraint on (booking_id, author_id)
      // is the real guard; the findOne above is just the friendly-error
      // fast path for the common case.
      if (err?.code === '23505') {
        throw new ConflictException('You have already reviewed this stay');
      }
      throw err;
    }

    return { success: true };
  }

  async getReviewsForListing(listingId: string) {
    const reviews = await this.reviewsRepo.find({
      where: { listing_id: listingId, role: 'guest_reviewing_host' },
      order: { created_at: 'DESC' },
    });

    if (!reviews.length) return { success: true, reviews: [] };

    const authorIds = Array.from(new Set(reviews.map((r) => r.author_id)));
    const authors = await this.profilesRepo.find({
      where: authorIds.map((id) => ({ id })),
      select: { id: true, full_name: true, avatar_url: true },
    });

    const authorMap = new Map(authors.map((a) => [a.id, a]));

    return {
      success: true,
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        content: r.content,
        createdAt: r.created_at,
        authorName: authorMap.get(r.author_id)?.full_name ?? 'Guest',
        authorAvatar: authorMap.get(r.author_id)?.avatar_url ?? null,
      })),
    };
  }
}
