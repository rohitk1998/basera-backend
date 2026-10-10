import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { UserEntity, VerificationRequestEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, VerificationRequestEntity]), forwardRef(() => AuthModule), NotificationsModule],
  controllers: [UserController],
  providers: [UserService],
  // AuthService.completeSignup uploads a picked avatar via
  // UserService.validateAvatarFile/uploadAvatarToStorage — see
  // AuthModule's forwardRef(() => UserModule) import.
  exports: [UserService],
})
export class UserModule {}
