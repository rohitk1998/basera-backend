import { RedisModule } from '../redis/redis.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module';
import { ListingEntity, UserEntity } from '../entities';
import { CrmModule } from '../crm/crm.module';
import { CrmService } from '../crm/crm.service';
import { StorageModule } from '../storage/storage.module';
import { AdminClaimsController, ClaimsController } from './claims.controller';
import { ClaimDisputeEntity, ClaimEvidenceEntity, ClaimEventEntity, PropertyClaimEntity, PropertyMemberEntity } from './claims.entities';
import { CLAIM_CRM_HOOK, CLAIM_INVITATION_LOOKUP, SqlInvitationLookup } from './claims.providers';
import { ClaimsScheduler } from './claims.scheduler';
import { ClaimsService } from './claims.service';
import { PropertyAccess } from './property-access.service';

/** CLAIM_CRM_HOOK is wired to CrmService.markConverted. CLAIM_NOTIFIER is optional and unwired (no claim notification events exist yet). */
@Module({
  imports: [
    RedisModule,
    TypeOrmModule.forFeature([
      PropertyClaimEntity, ClaimEvidenceEntity, ClaimEventEntity, ClaimDisputeEntity, PropertyMemberEntity, ListingEntity, UserEntity,
    ]),
    AuthModule,
    StorageModule,
    CrmModule,
  ],
  controllers: [ClaimsController, AdminClaimsController],
  providers: [
    ClaimsService,
    ClaimsScheduler,
    PropertyAccess,
    { provide: CLAIM_CRM_HOOK, useExisting: CrmService },
    { provide: CLAIM_INVITATION_LOOKUP, inject: [DataSource], useFactory: (ds: DataSource) => new SqlInvitationLookup((sql, p) => ds.query(sql, p)) },
  ],
  exports: [PropertyAccess],
})
export class ClaimsModule {}
