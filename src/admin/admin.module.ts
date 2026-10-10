import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ListingEntity,
  UserEntity,
  BookingEntity,
  NotificationLogEntity,
  PaymentEntity,
  DisputeCaseEntity,
  VerificationRequestEntity,
  VerificationAuditLogEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ListingsModule } from '../listings/listings.module';
import { BookingsModule } from '../bookings/bookings.module';
import { StorageModule } from '../storage/storage.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ListingEntity,
      UserEntity,
      BookingEntity,
      NotificationLogEntity,
      PaymentEntity,
          DisputeCaseEntity,
      VerificationRequestEntity,
      VerificationAuditLogEntity,
    ]),
    AuthModule,
    NotificationsModule,
    ListingsModule,
    BookingsModule,
    StorageModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
