import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

@Controller('api/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @UseGuards(AuthGuard)
  @ResponseMessage('Thanks for your review.')
  @Post('booking/:bookingId')
  createReview(
    @CurrentUser() user: AuthUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviewsService.createReview(user.userId, bookingId, dto);
  }

  @Get('listing/:listingId')
  getListingReviews(@Param('listingId') listingId: string) {
    return this.reviewsService.getReviewsForListing(listingId);
  }
}
