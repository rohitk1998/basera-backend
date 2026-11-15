import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ListingEntity,
  ListingTranslationEntity,
  UserEntity,
  BookingEntity,
  PhoneRevealLogEntity,
} from '../entities';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ListingsController } from './listings.controller';
import { HostListingsController } from './host-listings.controller';
import { ListingsService } from './listings.service';
import { PhoneRevealService } from './phone-reveal.service';
import { HostListingsService } from './host-listings.service';
import { ListingTranslationService } from './listing-translation.service';
import { CaptureConfigService } from './capture-config.service';
import { GeocodeController } from './geocode.controller';
import { GeocodeService } from './geocode.service';
import { SarvamTranslateProvider } from './providers/sarvam-translate.provider';
import { TRANSLATE_PROVIDER } from './providers/translate-provider.token';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ListingEntity,
      ListingTranslationEntity,
      UserEntity,
      BookingEntity,
      PhoneRevealLogEntity,
    ]),
    AuthModule,
    RedisModule,
  ],
  controllers: [ListingsController, HostListingsController, GeocodeController],
  providers: [
    CaptureConfigService,
    GeocodeService,
    ListingsService,
    PhoneRevealService,
    HostListingsService,
    ListingTranslationService,
    SarvamTranslateProvider,
    { provide: TRANSLATE_PROVIDER, useExisting: SarvamTranslateProvider },
  ],
  exports: [
    ListingsService,
    HostListingsService,
    ListingTranslationService,
    GeocodeService,
  ],
})
export class ListingsModule {}
