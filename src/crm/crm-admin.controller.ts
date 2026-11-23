import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CrmService } from './crm.service';
import {
  AnalyticsQueryDto, AssignLeadDto, CompleteTaskDto, CreateInvitationDto, CreateLeadDto, HostResponseDto,
  ListLeadsQueryDto, LogAttemptDto, MyTasksQueryDto, RecordConsentDto, ScheduleTaskDto, UpdateLeadDto,
} from './dto/crm.dto';

const uuid = () => new ParseUUIDPipe();

@Controller('api/admin/crm')
@UseGuards(AdminGuard)
export class CrmAdminController {
  constructor(private readonly crm: CrmService) {}

  @Get('leads') list(@Query() q: ListLeadsQueryDto) { return this.crm.listLeads(q); }

  @ResponseMessage('Lead created.')
  @Post('leads') create(@Body() dto: CreateLeadDto, @CurrentUser() u: AuthUser) { return this.crm.createLead(dto, u.userId); }

  @Get('leads/:id') get(@Param('id', uuid()) id: string) { return this.crm.getLead(id); }

  @ResponseMessage('Lead updated.')
  @Patch('leads/:id') update(@Param('id', uuid()) id: string, @Body() dto: UpdateLeadDto, @CurrentUser() u: AuthUser) { return this.crm.updateLead(id, dto, u.userId); }

  @ResponseMessage('Lead assigned.')
  @Post('leads/:id/assign') assign(@Param('id', uuid()) id: string, @Body() dto: AssignLeadDto) { return this.crm.assign(id, dto.staffId ?? null); }

  @ResponseMessage('Outreach logged.')
  @Post('leads/:id/attempts') log(@Param('id', uuid()) id: string, @Body() dto: LogAttemptDto, @CurrentUser() u: AuthUser) { return this.crm.logAttempt(id, dto, u.userId); }

  @ResponseMessage('Host response recorded.')
  @Post('leads/:id/response') response(@Param('id', uuid()) id: string, @Body() dto: HostResponseDto, @CurrentUser() u: AuthUser) { return this.crm.recordResponse(id, dto, u.userId); }

  @ResponseMessage('Consent recorded.')
  @Post('leads/:id/consent') consent(@Param('id', uuid()) id: string, @Body() dto: RecordConsentDto, @CurrentUser() u: AuthUser) { return this.crm.recordConsent(id, dto, u.userId); }

  @ResponseMessage('Lead marked do-not-contact.')
  @Post('leads/:id/do-not-contact') dnc(@Param('id', uuid()) id: string, @CurrentUser() u: AuthUser) { return this.crm.doNotContact(id, u.userId); }

  @ResponseMessage('Follow-up scheduled.')
  @Post('leads/:id/tasks') schedule(@Param('id', uuid()) id: string, @Body() dto: ScheduleTaskDto, @CurrentUser() u: AuthUser) { return this.crm.scheduleTask(id, dto, u.userId); }

  @ResponseMessage('Follow-up completed.')
  @Post('tasks/:taskId/complete') complete(@Param('taskId', uuid()) id: string, @Body() dto: CompleteTaskDto, @CurrentUser() u: AuthUser) { return this.crm.completeTask(id, dto, u.userId); }

  @Get('my-tasks') myTasks(@Query() q: MyTasksQueryDto, @CurrentUser() u: AuthUser) { return this.crm.myTasks(u.userId, q.scope ?? 'today'); }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage((r) => (r?.delivery === 'sent' ? 'Invitation sent.' : 'Invitation created. Share the link manually.'))
  @Post('leads/:id/invitations') invite(@Param('id', uuid()) id: string, @Body() dto: CreateInvitationDto, @CurrentUser() u: AuthUser) { return this.crm.createInvitation(id, dto, u.userId); }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage((r) => (r?.delivery === 'sent' ? 'Invitation resent.' : 'New invitation created. Share the link manually.'))
  @Post('invitations/:invId/resend') resend(@Param('invId', uuid()) id: string, @Body() dto: CreateInvitationDto, @CurrentUser() u: AuthUser) { return this.crm.resendInvitation(id, dto, u.userId); }

  @ResponseMessage('Invitation revoked.')
  @Post('invitations/:invId/revoke') revoke(@Param('invId', uuid()) id: string) { return this.crm.revokeInvitation(id); }

  @Get('analytics') analytics(@Query() q: AnalyticsQueryDto) { return this.crm.analytics(q); }
}
