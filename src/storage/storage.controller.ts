import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { StorageService } from './storage.service';
import { UploadUrlDto } from './dto/upload-url.dto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

@Controller('api/storage')
@UseGuards(AuthGuard)
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @ResponseMessage('Upload link created.')
  @Post('upload-url')
  createUploadUrl(@CurrentUser() user: AuthUser, @Body() dto: UploadUrlDto) {
    return this.storageService.createSignedUploadUrl(user.userId, dto.fileName, dto.bucket);
  }
}
