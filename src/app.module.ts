import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from './common/interceptors/response-message.interceptor';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env.validation';
import * as entities from './entities';
import { AuthModule } from './auth/auth.module';
import { ListingsModule } from './listings/listings.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { AdminModule } from './admin/admin.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { UserModule } from './user/user.module';
import { ConversationsModule } from './conversations/conversations.module';
import { ReviewsModule } from './reviews/reviews.module';
import { HostVerificationModule } from './host-verification/host-verification.module';
import { ClaimsModule } from './claims/claims.module';
import { AttractionsModule } from './attractions/attractions.module';
import { EventsModule } from './events/events.module';
import { BlogModule } from './blog/blog.module';
import { StoriesModule } from './stories/stories.module';
import { SocialModule } from './social/social.module';
import { CalendarSyncModule } from './calendar-sync/calendar-sync.module';
import { HostVettingModule } from './host-vetting/host-vetting.module';
import { GuidebookModule } from './guidebook/guidebook.module';
import { BookingAgreementModule } from './booking-agreement/booking-agreement.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { CrmModule } from './crm/crm.module';
import { QueueModule } from './queue/queue.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { AdminBookingsModule } from './admin-bookings/admin-bookings.module';
import { AdminLookupsModule } from './admin-lookups/admin-lookups.module';
import { HealthModule } from './health/health.module';
import { FinanceAdminModule } from './finance/finance-admin.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { AutomationModule } from './automation/automation.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    // NOTE: counters are in-process memory (per instance, reset on restart). A shared Redis store
    // needs a storage package (e.g. @nest-lab/throttler-storage-redis) which is not a dependency,
    // so with N replicas the effective limit is N x 60/min. Add that package to fix.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('SUPABASE_DB_HOST'),
        port: config.get<number>('SUPABASE_DB_PORT'),
        username: config.get<string>('SUPABASE_DB_USER'),
        password: config.get<string>('SUPABASE_DB_PASSWORD'),
        database: config.get<string>('SUPABASE_DB_NAME'),
        entities: Object.values(entities),
        synchronize: false,
        ssl: config.get<boolean>('DB_SSL') === false ? false : { rejectUnauthorized: false },
        extra: {
          max: config.get<number>('DB_POOL_MAX') ?? 10,
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 5_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
        },
        // Query logging dumps every SQL statement (with PII in parameters) into the logs; opt-in only.
        logging: (config.get<boolean>('DB_LOG_QUERIES') ? ['query', 'error']
          : ['error']) as ('query' | 'error')[],
      }),
    }),
    AuthModule,
    ListingsModule,
    BookingsModule,
    PaymentsModule,
    AdminModule,
    NotificationsModule,
    StorageModule,
    UserModule,
    ConversationsModule,
    ReviewsModule,
    HostVerificationModule,
    ClaimsModule,
    AttractionsModule,
    EventsModule,
    BlogModule,
    StoriesModule,
    SocialModule,
    CalendarSyncModule,
    HostVettingModule,
    GuidebookModule,
    BookingAgreementModule,
    WhatsappModule,
    CrmModule,
    HealthModule,
    QueueModule,
    DiscoveryModule,
    InquiriesModule,
    AutomationModule,
    AnalyticsModule,
    AdminBookingsModule,
    FinanceAdminModule,
    AdminLookupsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule { }
