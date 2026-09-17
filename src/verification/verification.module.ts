import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VerificationAuditLogEntity, VerificationRequestEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { DocumentAnalysisService } from './document-analysis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationRequestEntity, VerificationAuditLogEntity]),
    AuthModule,
    StorageModule,
    NotificationsModule,
  ],
  controllers: [VerificationController],
  providers: [VerificationService, DocumentAnalysisService],
})
export class VerificationModule {}
