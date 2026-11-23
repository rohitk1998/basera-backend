import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { JobRouterService, JobsLogService, QueueJobRegistry, QueueService, WORK_QUEUES } from '../queue';
import { AutomationService } from './automation.service';

export class UpdateAutomationDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Validated per automation against its paramSpec (see GET /api/admin/automations). */
  @IsOptional() @IsObject() params?: Record<string, unknown>;
}

export class PauseDto {
  @IsBoolean() paused: boolean;
}

export class RunNowDto {
  /** true: return who WOULD be notified; writes nothing and sends nothing. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class ListJobsQueryDto {
  @IsOptional() @IsIn(['active', 'completed', 'failed', 'dead']) state?: string;
  @IsOptional() @IsIn([...WORK_QUEUES]) queue?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class JobIdParam {
  @IsString() @Matches(/^\d{1,18}$/) id: string;
}

@Controller('api/admin/automations')
@UseGuards(AdminGuard)
@Throttle({ default: { ttl: 60_000, limit: 120 } })
export class AutomationController {
  constructor(
    private readonly service: AutomationService,
    private readonly jobsLog: JobsLogService,
    private readonly router: JobRouterService,
    private readonly queues: QueueService,
    private readonly registry: QueueJobRegistry,
  ) {}

  @Get()
  list() {
    return this.service.list();
  }

  @ResponseMessage((r) => (r.paused ? 'All automations paused.' : 'Automations resumed.'))
  @Patch('pause')
  pause(@Body() dto: PauseDto, @CurrentUser() admin: AuthUser) {
    return this.service.setPaused(dto.paused, admin.userId);
  }

  @Get('queue-health')
  async queueHealth() {
    return { ...(await this.queues.health()), handlers: this.registry.list().map((j) => ({ queue: j.queue, name: j.name, concurrency: j.concurrency, timeoutMs: j.timeoutMs })) };
  }

  @Get('jobs')
  jobs(@Query() q: ListJobsQueryDto) {
    return this.jobsLog.list({ state: q.state, queue: q.queue, limit: q.limit ?? 25, offset: q.offset ?? 0 });
  }

  @ResponseMessage('Job re-queued.')
  @Post('jobs/:id/retry')
  retry(@Param() p: JobIdParam) {
    return this.router.retry(p.id);
  }

  @ResponseMessage('Automation updated.')
  @Patch(':kind')
  update(@Param('kind') kind: string, @Body() dto: UpdateAutomationDto, @CurrentUser() admin: AuthUser) {
    return this.service.update(kind, dto, admin.userId);
  }

  @ResponseMessage((r) => (r.dryRun ? 'Dry run complete. Nothing was sent.' : 'Automation run complete.'))
  @Post(':kind/run')
  run(@Param('kind') kind: string, @Body() dto: RunNowDto, @CurrentUser() admin: AuthUser) {
    return this.service.run(kind, { dryRun: dto.dryRun === true, actor: admin.userId, force: true });
  }
}
