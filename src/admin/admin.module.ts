import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ListingEntity,
  ProfileEntity,
  BookingEntity,
  NotificationLogEntity,
  PaymentEntity,
  HostSubscriptionEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ListingsModule } from '../listings/listings.module';
import { BookingsModule } from '../bookings/bookings.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ListingEntity,
      ProfileEntity,
      BookingEntity,
      NotificationLogEntity,
      PaymentEntity,
      HostSubscriptionEntity,
    ]),
    AuthModule,
    NotificationsModule,
    ListingsModule,
    BookingsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
