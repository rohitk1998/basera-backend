import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { isSupportedLocale } from '../common/supported-locales';
import { UserService } from './user.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProfilePayloadDto } from './dto/profile-payload.dto';
import { HostKycDto } from './dto/host-kyc.dto';
import { SelfieVerificationDto } from './dto/selfie-verification.dto';
import { BankingVerificationDto } from './dto/banking-verification.dto';
import { BecomeHostDto } from './dto/become-host.dto';
import { PushTokenDto } from './dto/push-token.dto';
import { SetLocaleDto } from './dto/set-locale.dto';

interface UploadedMulterFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

@Controller('api/user')
@UseGuards(AuthGuard)
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('profile')
  getProfile(@CurrentUser() user: AuthUser) {
    return this.userService.getProfile(user.userId);
  }

  @Post('profile')
  async updateProfile(@CurrentUser() user: AuthUser, @Body() dto: ProfilePayloadDto) {
    const { isFirstTimeSignup } = await this.userService.updateProfile(user.userId, dto);

    if (isFirstTimeSignup) {
      // Fire-and-forget — never awaited, same as the original route. Gated
      // to fire exactly once per account by isFirstTimeSignup, captured
      // before the update above.
      this.notifications.notify('user.registered', user.userId, {
        userName: dto.name,
        isHost: dto.isHost ?? false,
        pushTitle: 'Welcome to Basera',
        pushBody: dto.isHost
          ? 'Complete verification to list your first property'
          : 'Complete your KYC to explore stays and services offered by our hosts and enjoy a smooth booking experience.',
        link: dto.isHost ? '/account?verify=1' : '/stays',
      });
    }

    return { success: true };
  }

  /**
   * Sets `isHost` on the caller's own account — the "Become a host" entry
   * point. Deliberately narrower than POST above: never touches name,
   * avatar, or languages.
   */
  @Patch('profile')
  becomeHost(@CurrentUser() user: AuthUser, @Body() dto: BecomeHostDto) {
    return this.userService.setIsHost(user.userId, dto.isHost);
  }

  @Post('kyc')
  saveKyc(@CurrentUser() user: AuthUser, @Body() dto: HostKycDto) {
    return this.userService.saveHostKyc(user.userId, dto);
  }

  // Account-level verification steps — open to guests and hosts alike,
  // unlike POST kyc above (host-only). See verification-gate.util.ts for
  // where these are enforced.
  @Post('verification/selfie')
  saveSelfie(@CurrentUser() user: AuthUser, @Body() dto: SelfieVerificationDto) {
    return this.userService.saveSelfie(user.userId, dto);
  }

  @Post('verification/banking')
  saveBanking(@CurrentUser() user: AuthUser, @Body() dto: BankingVerificationDto) {
    return this.userService.saveBanking(user.userId, dto);
  }

  @Post('avatar')
  @UseInterceptors(FileInterceptor('avatar'))
  uploadAvatar(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.userService.uploadAvatar(user.userId, file);
  }

  @Post('push-token')
  addPushToken(@CurrentUser() user: AuthUser, @Body() dto: PushTokenDto) {
    return this.userService.addPushToken(user.userId, dto.token);
  }

  @Delete('push-token')
  removePushToken(@CurrentUser() user: AuthUser, @Body() dto: PushTokenDto) {
    return this.userService.removePushToken(user.userId, dto.token);
  }

  @Post('locale')
  setLocale(@CurrentUser() user: AuthUser, @Body() dto: SetLocaleDto) {
    if (!isSupportedLocale(dto.locale)) {
      throw new BadRequestException('Unsupported locale');
    }
    return this.userService.setPreferredLocale(user.userId, dto.locale);
  }
}
