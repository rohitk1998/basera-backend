import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { isSupportedLocale } from '../common/supported-locales';
import { NotificationsService } from './notifications.service';
import { MarkReadDto } from './dto/mark-read.dto';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

/**
 * The caller's own notification history — what /notifications reads.
 * notification_log has no RLS that works for this app (its policy checks
 * auth.uid(), which is always null here — sessions are Firebase-derived,
 * not Supabase Auth), so this controller does the same manual
 * user_id filtering every other route in this app already does.
 */
@Controller('api/notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() query: ListNotificationsQueryDto) {
    const { notifications, nextCursor } = await this.notifications.listForUser(
      user.userId,
      query.before,
      query.beforeId,
      isSupportedLocale(query.locale) ? query.locale : undefined,
    );
    return { success: true, notifications, nextCursor };
  }

  @ResponseMessage('Notifications marked as read.')
  @Post('mark-read')
  async markRead(@CurrentUser() user: AuthUser, @Body() dto: MarkReadDto) {
    await this.notifications.markRead(user.userId, dto);
    return { success: true };
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser) {
    const count = await this.notifications.unreadCount(user.userId);
    return { success: true, count };
  }
}
