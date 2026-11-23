import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BookingEntity,
  BookingEventEntity,
  ListingEntity,
  UserEntity,
  ReviewEntity,
  DisputeCaseEntity,
  DisputeEventEntity,
  BookingOfferEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CalendarSyncModule } from '../calendar-sync/calendar-sync.module';
import { CashfreeModule } from '../payments/cashfree.module';
import { FinanceModule } from '../finance/finance.module';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentWebhookController } from './payment-webhook.controller';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingReleaseScheduler } from './booking-release.scheduler';
import { BookingOffersService } from './booking-offers.service';
import { AdminBookingOffersController, BookingOffersController } from './booking-offers.controller';
import { BookingOffersProcessor, BookingOffersScheduler } from './booking-offers.scheduler';
import { workerProviders } from '../queue';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BookingEntity,
      BookingEventEntity,
      ListingEntity,
      UserEntity,
      ReviewEntity,
      DisputeCaseEntity,
      DisputeEventEntity,
      BookingOfferEntity,
    ]),
    AuthModule,
    NotificationsModule,
    PaymentsModule,
    FinanceModule,
    CashfreeModule,
    CalendarSyncModule,
  ],
  controllers: [BookingsController, BookingOffersController, AdminBookingOffersController, PaymentWebhookController],
  providers: [
    BookingsService,
    BookingReleaseScheduler,
    BookingOffersService,
    BookingOffersScheduler,
    ...workerProviders(BookingOffersProcessor),
  ],
  exports: [BookingsService, BookingOffersService],
})
export class BookingsModule {}
