import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { BookingEntity, ListingEntity } from '../entities';
import { ListingCalendarBlockEntity } from './calendar-block.entity';
import { ListingCalendarSyncEntity } from './calendar-sync.entity';
import { CalendarFeedController, HostCalendarSyncController } from './calendar-sync.controller';
import { CalendarSyncScheduler } from './calendar-sync.scheduler';
import { CalendarSyncService } from './calendar-sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ListingCalendarSyncEntity, ListingCalendarBlockEntity, BookingEntity, ListingEntity]),
    AuthModule,
  ],
  controllers: [CalendarFeedController, HostCalendarSyncController],
  providers: [CalendarSyncService, CalendarSyncScheduler],
  exports: [CalendarSyncService],
})
export class CalendarSyncModule {}
