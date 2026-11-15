import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { StayChatService } from './stay-chat.service';
import { PostStayChatMessageDto } from './dto/stay-chat-post.dto';
import { StayChatListQueryDto } from './dto/stay-chat-list-query.dto';

@UseGuards(AuthGuard)
@Controller('api/social/listings/:listingId/chat')
export class StayChatController {
  constructor(private readonly chat: StayChatService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @Query() query: StayChatListQueryDto,
  ) {
    const page = await this.chat.list(user.userId, listingId, query);
    return { success: true, ...page };
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage('Message sent.')
  @Post()
  async post(
    @CurrentUser() user: AuthUser,
    @Param('listingId', ParseUUIDPipe) listingId: string,
    @Body() dto: PostStayChatMessageDto,
  ) {
    const message = await this.chat.post(user.userId, listingId, dto.body);
    return { message };
  }
}
