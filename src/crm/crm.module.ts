import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { UserEntity } from '../entities';
import { NotificationsModule } from '../notifications/notifications.module';
import { workerProviders } from '../queue';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CrmAdminController } from './crm-admin.controller';
import { registerHostInvitationEmail } from './crm-email';
import { CrmPublicController } from './crm-public.controller';
import { FollowUpTaskEntity, HostInvitationEntity, HostLeadEntity, OutreachAttemptEntity } from './crm.entities';
import { CrmFollowUpProcessor, CrmScheduler } from './crm.scheduler';
import { CrmService } from './crm.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([HostLeadEntity, OutreachAttemptEntity, HostInvitationEntity, FollowUpTaskEntity, UserEntity]),
    AuthModule, NotificationsModule, WhatsappModule,
  ],
  controllers: [CrmAdminController, CrmPublicController],
  providers: [CrmService, CrmScheduler, ...workerProviders(CrmFollowUpProcessor)],
  exports: [CrmService],
})
export class CrmModule implements OnModuleInit {
  onModuleInit() { registerHostInvitationEmail(); }
}
