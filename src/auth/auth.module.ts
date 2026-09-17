import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { SupabaseProvider } from './supabase.provider';
import { UserEntity, EmailOtpEntity } from '../entities';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, EmailOtpEntity]),
    forwardRef(() => NotificationsModule),
  ],
  controllers: [AuthController],
  providers: [AuthGuard, AdminGuard, FirebaseAdminProvider, SupabaseProvider],
  exports: [AuthGuard, AdminGuard, FirebaseAdminProvider, SupabaseProvider, TypeOrmModule],
})
export class AuthModule {}
