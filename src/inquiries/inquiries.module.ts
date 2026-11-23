import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BookingEntity,
  InquiryEntity,
  InquiryEventEntity,
  InquiryMessageEntity,
  ListingEntity,
  UserEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { BookingsModule } from '../bookings/bookings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { workerProviders } from '../queue';
import { AdminInquiriesController } from './admin-inquiries.controller';
import { InquiriesController } from './inquiries.controller';
import { InquiriesProcessor, InquiriesScheduler } from './inquiries.scheduler';
import { InquiriesService } from './inquiries.service';
import { InquiryAdminNotices } from './inquiry-admin-notices.service';
import { InquiryGuestNotices } from './inquiry-guest-notices.service';
import { InquiryNoticeCore } from './inquiry-notice-core.service';
import { InquiryOwnerRequestService } from './inquiry-owner-request.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InquiryEntity, InquiryMessageEntity, InquiryEventEntity, ListingEntity, UserEntity, BookingEntity]),
    AuthModule,
    NotificationsModule,
    BookingsModule,
    WhatsappModule,
    DiscoveryModule,
  ],
  controllers: [InquiriesController, AdminInquiriesController],
  providers: [InquiriesService, InquiryNoticeCore, InquiryGuestNotices, InquiryAdminNotices, InquiryOwnerRequestService, InquiriesScheduler, ...workerProviders(InquiriesProcessor)],
  exports: [InquiriesService],
})
export class InquiriesModule {}
