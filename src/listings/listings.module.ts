import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingEntity, ListingTranslationEntity, UserEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ListingsController } from './listings.controller';
import { HostListingsController } from './host-listings.controller';
import { ListingsService } from './listings.service';
import { HostListingsService } from './host-listings.service';
import { ListingTranslationService } from './listing-translation.service';
import { SarvamTranslateProvider } from './providers/sarvam-translate.provider';
import { TRANSLATE_PROVIDER } from './providers/translate-provider.token';

@Module({
  imports: [
    TypeOrmModule.forFeature([ListingEntity, ListingTranslationEntity, UserEntity]),
    AuthModule,
    RedisModule,
  ],
  controllers: [ListingsController, HostListingsController],
  providers: [
    ListingsService,
    HostListingsService,
    ListingTranslationService,
    SarvamTranslateProvider,
    { provide: TRANSLATE_PROVIDER, useExisting: SarvamTranslateProvider },
  ],
  exports: [ListingsService, HostListingsService, ListingTranslationService],
})
export class ListingsModule {}
