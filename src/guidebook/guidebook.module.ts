import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingEntity, ListingEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { GuidebookEntity } from './guidebook.entity';
import { GuidebookController } from './guidebook.controller';
import { GuidebookService } from './guidebook.service';

@Module({
  imports: [TypeOrmModule.forFeature([GuidebookEntity, ListingEntity, BookingEntity]), AuthModule],
  controllers: [GuidebookController],
  providers: [GuidebookService],
})
export class GuidebookModule {}
