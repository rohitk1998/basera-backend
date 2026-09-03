import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AdminGuard } from './admin.guard';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { SupabaseProvider } from './supabase.provider';
import { ProfileEntity } from '../entities';

@Module({
  imports: [TypeOrmModule.forFeature([ProfileEntity])],
  controllers: [AuthController],
  providers: [AuthGuard, AdminGuard, FirebaseAdminProvider, SupabaseProvider],
  exports: [AuthGuard, AdminGuard, FirebaseAdminProvider, SupabaseProvider, TypeOrmModule],
})
export class AuthModule {}
