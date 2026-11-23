import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingEntity, ListingEntity, UserEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { BookingAgreementAckEntity } from './booking-agreement-ack.entity';
import { BookingAgreementController } from './booking-agreement.controller';
import { BookingAgreementService } from './booking-agreement.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([BookingEntity, ListingEntity, UserEntity, BookingAgreementAckEntity]),
    AuthModule,
  ],
  controllers: [BookingAgreementController],
  providers: [BookingAgreementService],
})
export class BookingAgreementModule {}
