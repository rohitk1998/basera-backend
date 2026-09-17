import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CallEntity,
  ConversationEntity,
  ConversationPresenceEntity,
  ListingEntity,
  MessageEntity,
  UserEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ConversationEntity,
      MessageEntity,
      CallEntity,
      ListingEntity,
      UserEntity,
      ConversationPresenceEntity,
    ]),
    AuthModule,
    NotificationsModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
