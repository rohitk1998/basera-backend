import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ReviewsService } from './reviews.service';

const GUEST = 'g1';
const HOST = 'h1';

function makeService(booking: Record<string, unknown> | null, existing: unknown = null, insertErr?: unknown) {
  const reviewsRepo = {
    findOne: jest.fn().mockResolvedValue(existing),
    find: jest.fn().mockResolvedValue([]),
    insert: insertErr ? jest.fn().mockRejectedValue(insertErr) : jest.fn().mockResolvedValue(undefined),
  };
  const bookingsRepo = {
    findOne: jest.fn().mockResolvedValue(
      booking && { id: 'b1', status: 'completed', guest_id: GUEST, host_id: HOST, listing_id: 'l1', ...booking },
    ),
  };
  const service = new ReviewsService(reviewsRepo as never, bookingsRepo as never, {} as never);
  return { service, reviewsRepo };
}

describe('ReviewsService.createReview', () => {
  it('host reviews the guest: target is the guest, no listing, host role', async () => {
    const { service, reviewsRepo } = makeService({});
    await service.createReview(HOST, 'b1', { rating: 4, content: '  Tidy guest  ' });
    expect(reviewsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        author_id: HOST,
        target_user_id: GUEST,
        listing_id: null,
        role: 'host_reviewing_guest',
        content: 'Tidy guest',
      }),
    );
  });

  it('guest review still targets the host and the listing', async () => {
    const { service, reviewsRepo } = makeService({});
    await service.createReview(GUEST, 'b1', { rating: 5, content: 'Lovely' });
    expect(reviewsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ target_user_id: HOST, listing_id: 'l1', role: 'guest_reviewing_host' }),
    );
  });

  it('rejects a host review before the stay is complete', async () => {
    const { service } = makeService({ status: 'checked_in' });
    await expect(service.createReview(HOST, 'b1', { rating: 4, content: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects someone who is not on the booking', async () => {
    const { service } = makeService({});
    await expect(service.createReview('stranger', 'b1', { rating: 4, content: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a second host review, including the unique-violation race', async () => {
    const dup = makeService({}, { id: 'r1' });
    await expect(dup.service.createReview(HOST, 'b1', { rating: 4, content: 'x' })).rejects.toBeInstanceOf(ConflictException);
    const race = makeService({}, null, { code: '23505' });
    await expect(race.service.createReview(HOST, 'b1', { rating: 4, content: 'x' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects whitespace-only comments', async () => {
    const { service } = makeService({});
    await expect(service.createReview(HOST, 'b1', { rating: 4, content: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listing endpoint only queries guest_reviewing_host', async () => {
    const { service, reviewsRepo } = makeService({});
    await service.getReviewsForListing('l1');
    expect(reviewsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { listing_id: 'l1', role: 'guest_reviewing_host' } }),
    );
  });
});
