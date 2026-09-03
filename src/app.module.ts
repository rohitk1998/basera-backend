import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env.validation';
import * as entities from './entities';
import { AuthModule } from './auth/auth.module';
import { ListingsModule } from './listings/listings.module';
import { BookingsModule } from './bookings/bookings.module';
import { PaymentsModule } from './payments/payments.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { AdminModule } from './admin/admin.module';
import { NotificationsModule } from './notifications/notifications.module';
import { StorageModule } from './storage/storage.module';
import { UserModule } from './user/user.module';
import { MocksModule } from './mocks/mocks.module';
import { ConversationsModule } from './conversations/conversations.module';
import { ReviewsModule } from './reviews/reviews.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
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
        synchronize: false, // schema is managed by supabase/migrations SQL, ported as-is
        ssl: { rejectUnauthorized: false },
        // pg defaults to a max pool of 10, which the translation cache's
        // added query volume (a lookup alongside every listings/listing
        // read) makes too easy to exhaust under concurrent traffic.
        extra: { max: config.get<number>('DB_POOL_MAX') ?? 20 },
      }),
    }),
    AuthModule,
    ListingsModule,
    BookingsModule,
    PaymentsModule,
    SubscriptionsModule,
    AdminModule,
    NotificationsModule,
    StorageModule,
    UserModule,
    MocksModule,
    ConversationsModule,
    ReviewsModule,
  ],
})
export class AppModule { }
