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
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CashfreeModule } from '../payments/cashfree.module';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentWebhookController } from './payment-webhook.controller';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingReleaseScheduler } from './booking-release.scheduler';

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
    ]),
    AuthModule,
    NotificationsModule,
    PaymentsModule,
    CashfreeModule,
  ],
  controllers: [BookingsController, PaymentWebhookController],
  providers: [BookingsService, BookingReleaseScheduler],
  exports: [BookingsService],
})
export class BookingsModule {}
