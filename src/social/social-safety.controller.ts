import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { SocialSafetyService } from './social-safety.service';
import { CreateBlockDto } from './dto/create-block.dto';
import { CreateReportDto } from './dto/create-report.dto';

@UseGuards(AuthGuard)
@Controller('api/social')
export class SocialSafetyController {
  constructor(private readonly safety: SocialSafetyService) {}

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage('User blocked.')
  @Post('blocks')
  async block(@CurrentUser() user: AuthUser, @Body() dto: CreateBlockDto) {
    await this.safety.block(user.userId, dto.userId);
    return {};
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage('User unblocked.')
  @HttpCode(200)
  @Delete('blocks/:userId')
  async unblock(
    @CurrentUser() user: AuthUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    await this.safety.unblock(user.userId, userId);
    return {};
  }

  @Throttle({ default: { ttl: 600_000, limit: 10 } })
  @ResponseMessage('Thanks, we will review this report.')
  @Post('reports')
  createReport(@CurrentUser() user: AuthUser, @Body() dto: CreateReportDto) {
    return this.safety.createReport(user.userId, dto);
  }
}
