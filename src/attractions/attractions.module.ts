import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttractionEntity } from '../entities/attraction.entity';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ListingsModule } from '../listings/listings.module';
import { AttractionsController } from './attractions.controller';
import { AdminAttractionsController } from './admin-attractions.controller';
import { AttractionsService } from './attractions.service';
import { AttractionsImportService } from './attractions-import.service';
import { AttractionImagesService } from './attraction-images.service';
import { AttractionsScheduler } from './attractions.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([AttractionEntity]),
    AuthModule,
    RedisModule,
    ListingsModule,
  ],
  controllers: [AttractionsController, AdminAttractionsController],
  providers: [
    AttractionsService,
    AttractionsImportService,
    AttractionImagesService,
    AttractionsScheduler,
  ],
  exports: [AttractionsService, AttractionsImportService],
})
export class AttractionsModule {}
