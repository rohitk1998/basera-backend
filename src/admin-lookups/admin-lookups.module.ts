import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminLookupsController } from './admin-lookups.controller';
import { AdminLookupsService } from './admin-lookups.service';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [AdminLookupsController],
  providers: [AdminLookupsService],
})
export class AdminLookupsModule {}
