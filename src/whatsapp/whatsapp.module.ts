import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { WhatsappConsentChecker } from '../crm/whatsapp-consent.checker';
import { WhatsappMessageEntity } from './whatsapp-message.entity';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappService } from './whatsapp.service';
import { CONSENT_CHECKER } from './whatsapp.types';

@Module({
  imports: [TypeOrmModule.forFeature([WhatsappMessageEntity]), NotificationsModule],
  controllers: [WhatsappWebhookController],
  // Bound to the contact_preferences-backed checker (CRM): consent only on explicit grant, DNC leads blocked.
  providers: [WhatsappService, { provide: CONSENT_CHECKER, useClass: WhatsappConsentChecker }],
  exports: [WhatsappService],
})
export class WhatsappModule {}
