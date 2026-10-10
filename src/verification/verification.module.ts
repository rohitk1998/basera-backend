import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity, VerificationAuditLogEntity, VerificationRequestEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CashfreeModule } from '../payments/cashfree.module';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { DiditController } from './didit.controller';
import { DiditService } from './didit.service';
import { DocumentAnalysisService } from './document-analysis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([VerificationRequestEntity, VerificationAuditLogEntity, UserEntity]),
    AuthModule,
    StorageModule,
    NotificationsModule,
    CashfreeModule,
  ],
  controllers: [VerificationController, DiditController],
  providers: [VerificationService, DocumentAnalysisService, DiditService],
  exports: [VerificationService],
})
export class VerificationModule {}
