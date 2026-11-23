import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AutomationController } from './automation.controller';
import { AutomationScheduler } from './automation.scheduler';
import { AutomationService } from './automation.service';

/** QueueModule is @Global: QueueJobRegistry / JobRouterService / JobsLogService are available without importing it. */
@Module({
  imports: [AuthModule, NotificationsModule, WhatsappModule],
  controllers: [AutomationController],
  providers: [AutomationService, AutomationScheduler],
  exports: [AutomationService],
})
export class AutomationModule {}
