import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import {
  AssignDto, CreateJobDto, DuplicateDto, ListCandidatesDto, ListJobsDto, PutSettingsDto, RunNowDto, TransitionDto, UsageQueryDto,
} from './discovery.dto';
import { DiscoveryService } from './discovery.service';

const uuid = new ParseUUIDPipe();
const RUN_LIMIT = { default: { ttl: 60_000, limit: 10 } };

@Controller('api/admin/discovery')
@UseGuards(AdminGuard)
export class DiscoveryController {
  constructor(private readonly svc: DiscoveryService) {}

  @Get('settings')
  settings() { return this.svc.listSettings(); }

  @ResponseMessage('Discovery settings saved.')
  @Put('settings/:destination')
  putSettings(@Param('destination') destination: string, @Body() dto: PutSettingsDto, @CurrentUser() u: AuthUser) {
    return this.svc.putSettings(destination, dto, u.userId);
  }

  @Get('jobs')
  jobs(@Query() q: ListJobsDto) { return this.svc.listJobs(q); }

  @ResponseMessage('Discovery job queued.')
  @Throttle(RUN_LIMIT)
  @Post('jobs')
  createJob(@Body() dto: CreateJobDto, @CurrentUser() u: AuthUser) { return this.svc.createJob(dto, u.userId); }

  @ResponseMessage('Discovery run queued.')
  @Throttle(RUN_LIMIT)
  @Post('run-now')
  runNow(@Body() dto: RunNowDto, @CurrentUser() u: AuthUser) { return this.svc.runNow(dto.destination, u.userId); }

  @Get('jobs/:id')
  job(@Param('id', uuid) id: string) { return this.svc.getJob(id); }

  @ResponseMessage('Job paused.')
  @Post('jobs/:id/pause')
  pause(@Param('id', uuid) id: string) { return this.svc.pauseJob(id); }

  @ResponseMessage('Job cancelled.')
  @Post('jobs/:id/cancel')
  cancel(@Param('id', uuid) id: string) { return this.svc.cancelJob(id); }

  @ResponseMessage('Job resumed.')
  @Throttle(RUN_LIMIT)
  @Post('jobs/:id/resume')
  resume(@Param('id', uuid) id: string) { return this.svc.resumeJob(id); }

  @Get('candidates')
  candidates(@Query() q: ListCandidatesDto) { return this.svc.listCandidates(q); }

  /** Discovered-listing count per destination, for the admin Destination dropdown. Declared before `:id` so it is not parsed as a UUID. */
  @Get('candidates/counts')
  candidateCounts() { return this.svc.candidateCounts(); }

  @Get('candidates/:id')
  candidate(@Param('id', uuid) id: string) { return this.svc.getCandidate(id); }

  @ResponseMessage('Candidate state updated.')
  @Patch('candidates/:id/state')
  transition(@Param('id', uuid) id: string, @Body() dto: TransitionDto, @CurrentUser() u: AuthUser) {
    return this.svc.transition(id, dto.to, u.userId, dto.note);
  }

  @ResponseMessage('Candidate assignment updated.')
  @Patch('candidates/:id/assign')
  assign(@Param('id', uuid) id: string, @Body() dto: AssignDto) { return this.svc.assign(id, dto.assigned_to); }

  @ResponseMessage('Candidate marked as duplicate and archived.')
  @Post('candidates/:id/duplicate')
  duplicate(@Param('id', uuid) id: string, @Body() dto: DuplicateDto, @CurrentUser() u: AuthUser) {
    return this.svc.markDuplicate(id, dto.duplicate_of, u.userId);
  }

  @ResponseMessage('Candidate archived.')
  @Post('candidates/:id/archive')
  archive(@Param('id', uuid) id: string, @CurrentUser() u: AuthUser) { return this.svc.archive(id, u.userId); }

  @Get('api-usage')
  usage(@Query() q: UsageQueryDto) { return this.svc.apiUsage(q.days); }

  @Get('sources')
  sources() { return this.svc.listSources(); }
}
