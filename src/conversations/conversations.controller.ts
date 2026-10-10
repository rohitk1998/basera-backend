import { Body, Controller, Param, Patch, Post, UseGuards, Get } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { StartCallDto } from './dto/start-call.dto';
import { UpdateCallDto } from './dto/update-call.dto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

@Controller('api/conversations')
@UseGuards(AuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.conversations.list(user.userId);
  }

  @ResponseMessage('Conversation ready.')
  @Post()
  getOrCreate(@CurrentUser() user: AuthUser, @Body() dto: CreateConversationDto) {
    return this.conversations.getOrCreate(user.userId, dto);
  }

  // Message history itself is read directly by the browser via Supabase
  // (RLS-gated) with a postgres_changes subscription for live delivery —
  // no GET route here. This is the only write path.
  @ResponseMessage('Message sent.')
  @Post(':id/messages')
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.conversations.sendMessage(user.userId, conversationId, dto);
  }

  // Called every ~15s by the client while the thread is open and the tab
  // is foregrounded — see ConversationPresenceEntity. No response body
  // needed; the caller doesn't act on this beyond firing it.
  @ResponseMessage('Presence updated.')
  @Post(':id/presence')
  heartbeat(@CurrentUser() user: AuthUser, @Param('id') conversationId: string) {
    return this.conversations.heartbeat(user.userId, conversationId);
  }

  @ResponseMessage('Call started.')
  @Post(':id/calls')
  startCall(
    @CurrentUser() user: AuthUser,
    @Param('id') conversationId: string,
    @Body() dto: StartCallDto,
  ) {
    return this.conversations.startCall(user.userId, conversationId, dto);
  }

  @ResponseMessage('Call updated.')
  @Patch(':id/calls/:callId')
  updateCall(
    @CurrentUser() user: AuthUser,
    @Param('id') conversationId: string,
    @Param('callId') callId: string,
    @Body() dto: UpdateCallDto,
  ) {
    return this.conversations.updateCall(user.userId, conversationId, callId, dto);
  }
}
