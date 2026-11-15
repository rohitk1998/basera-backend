import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  BookingEntity,
  GuestProfileEntity,
  ListingEntity,
  MeetupEntity,
  MeetupMemberEntity,
  ReportEntity,
  StayChatMessageEntity,
  StoryEntity,
  UserBlockEntity,
  UserEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { SocialAccessService } from './social-access.service';
import { GuestProfileController } from './guest-profile.controller';
import { GuestProfileService } from './guest-profile.service';
import { SocialSafetyController } from './social-safety.controller';
import { SocialSafetyService } from './social-safety.service';
import { MeetupsController } from './meetups.controller';
import { MeetupsService } from './meetups.service';
import { StayChatController } from './stay-chat.controller';
import { StayChatService } from './stay-chat.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BookingEntity,
      GuestProfileEntity,
      ListingEntity,
      MeetupEntity,
      MeetupMemberEntity,
      ReportEntity,
      StayChatMessageEntity,
      StoryEntity,
      UserBlockEntity,
      UserEntity,
    ]),
    AuthModule,
  ],
  controllers: [
    GuestProfileController,
    SocialSafetyController,
    MeetupsController,
    StayChatController,
  ],
  providers: [
    SocialAccessService,
    GuestProfileService,
    SocialSafetyService,
    MeetupsService,
    StayChatService,
  ],
  exports: [SocialAccessService, SocialSafetyService],
})
export class SocialModule {}
