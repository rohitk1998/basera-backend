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
import { VerificationModule } from './verification/verification.module';

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
        // Local test Postgres (Docker) doesn't speak SSL; only the real
        // Supabase pooler needs it. DB_SSL=false in .env.test opts out.
        ssl: config.get<string>('DB_SSL') === 'false' ? false : { rejectUnauthorized: false },
        // pg defaults to a max pool of 10, which the translation cache's
        // added query volume (a lookup alongside every listings/listing
        // read) makes too easy to exhaust under concurrent traffic. BUT:
        // Supabase's session-mode pooler hard-caps at 15 total connections
        // — a max above that (this used to default to 20 here) doesn't
        // raise the real ceiling, it just guarantees EMAXCONNSESSION errors
        // under load, surfacing as a 500 on whichever unrelated request
        // happened to need a connection at that moment. DB_POOL_MAX in
        // .env is the real knob now; this fallback stays under 15 too so a
        // missing env var can't silently regress back to overshooting the
        // pooler. idleTimeoutMillis actually releases idle connections
        // instead of holding them open indefinitely, which matters more
        // than the max once the max is sane.
        //
        // connectionTimeoutMillis is the other half of "fail fast, not
        // silently slow": with no explicit value here, `pg` falls back to
        // the raw OS/network TCP timeout when the pooler is unreachable —
        // observed in practice as a single request hanging for 60-70+
        // seconds before erroring (ETIMEDOUT/EHOSTUNREACH against
        // Supabase's pooler IPs) instead of failing in a few seconds with a
        // clear error. A DB outage is still an outage either way; this
        // just stops it from *also* masquerading as an apparently-slow
        // endpoint on whatever unlucky request needed a fresh connection.
        extra: {
          max: config.get<number>('DB_POOL_MAX') ?? 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 8_000,
        },
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
    VerificationModule,
  ],
})
export class AppModule { }
