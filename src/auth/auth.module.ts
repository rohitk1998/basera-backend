import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { SupabaseProvider } from './supabase.provider';
import { UserEntity, EmailOtpEntity } from '../entities';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, EmailOtpEntity]),
    forwardRef(() => NotificationsModule),
    forwardRef(() => UserModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, AdminGuard, FirebaseAdminProvider, SupabaseProvider],
  exports: [AuthService, AuthGuard, AdminGuard, FirebaseAdminProvider, SupabaseProvider, TypeOrmModule],
})
export class AuthModule {}
