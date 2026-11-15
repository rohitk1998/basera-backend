import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { EventEntity, StoryEntity, UserEntity } from '../entities';
import { SocialModule } from '../social/social.module';
import {
  AdminStoriesController,
  StoriesController,
} from './stories.controller';
import { StoriesMediaController } from './stories-media.controller';
import { StoriesService } from './stories.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StoryEntity, UserEntity, EventEntity]),
    AuthModule,
    SocialModule,
  ],
  controllers: [StoriesController, AdminStoriesController, StoriesMediaController],
  providers: [StoriesService],
  exports: [StoriesService],
})
export class StoriesModule {}
