import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HostVerificationCaseEntity, UserEntity, VerificationAuditEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { FaceMatchService } from './face-match.service';
import { HostVerificationAdminController } from './host-verification-admin.controller';
import { HostVerificationController } from './host-verification.controller';
import { HostVerificationScheduler } from './host-verification.scheduler';
import { HostVerificationService } from './host-verification.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([HostVerificationCaseEntity, UserEntity, VerificationAuditEntity]),
    AuthModule,
    StorageModule,
  ],
  controllers: [HostVerificationController, HostVerificationAdminController],
  providers: [HostVerificationService, FaceMatchService, HostVerificationScheduler],
  exports: [HostVerificationService],
})
export class HostVerificationModule {}
