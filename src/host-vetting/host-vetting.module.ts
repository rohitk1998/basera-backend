import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { HostVettingController } from './host-vetting.controller';
import { HostVettingService } from './host-vetting.service';
import { ListingAuditEntity } from './listing-audit.entity';
import { ListingVettingEntity } from './listing-vetting.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ListingVettingEntity, ListingAuditEntity, ListingEntity]), AuthModule],
  controllers: [HostVettingController],
  providers: [HostVettingService],
})
export class HostVettingModule {}
