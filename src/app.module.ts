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
import { VerificationModule } from './verification/verification.module';
import { AttractionsModule } from './attractions/attractions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
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
        ssl: config.get<string>('DB_SSL') === 'false' ? false : { rejectUnauthorized: false },
        extra: {
          max: config.get<number>('DB_POOL_MAX') ?? 10,
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 5_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
        },
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
    VerificationModule,
    AttractionsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule { }
