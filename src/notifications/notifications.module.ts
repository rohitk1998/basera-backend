import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContactPreferenceEntity, NotificationLogEntity, UserEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';
import { ConsentService } from './consent.service';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, NotificationLogEntity, ContactPreferenceEntity]), forwardRef(() => AuthModule)],
  controllers: [NotificationsController],
  providers: [NotificationsService, ConsentService],
  exports: [NotificationsService, ConsentService],
})
export class NotificationsModule {}
