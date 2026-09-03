import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingEntity, BookingEventEntity, ListingEntity, ProfileEntity, ReviewEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingReleaseScheduler } from './booking-release.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([BookingEntity, BookingEventEntity, ListingEntity, ProfileEntity, ReviewEntity]),
    AuthModule,
    NotificationsModule,
    PaymentsModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService, BookingReleaseScheduler],
  exports: [BookingsService],
})
export class BookingsModule {}
