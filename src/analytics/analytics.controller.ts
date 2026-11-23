import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { SECTIONS, Section } from './analytics.metrics';
import { AnalyticsService } from './analytics.service';

const ISO = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export class AnalyticsQueryDto {
  /** ISO date or timestamp, inclusive. Default: `to` minus 30 days. */
  @IsOptional() @IsString() @Matches(ISO) from?: string;
  /** ISO timestamp (exclusive) or a bare YYYY-MM-DD (inclusive of that UTC day). Default: now. */
  @IsOptional() @IsString() @Matches(ISO) to?: string;
  /** Admin cache-bust: skip the 60s Redis cache and recompute. */
  @IsOptional() @Transform(({ value }) => value === true || value === 'true' || value === '1') @IsBoolean() refresh?: boolean;
}

export class AddAcquisitionCostDto {
  /** Month the spend belongs to, YYYY-MM. */
  @IsString() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period: string;
  @IsInt() @Min(0) @Max(1_000_000_000) amountRupees: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@Controller('api/admin/analytics')
@UseGuards(AdminGuard)
@Throttle({ default: { ttl: 60_000, limit: 60 } })
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('definitions')
  definitions() {
    return this.service.definitions();
  }

  @Get('overview')
  overview(@Query() q: AnalyticsQueryDto) {
    return this.service.overview(q.from, q.to, q.refresh === true);
  }

  @Get('acquisition-costs')
  listCosts() {
    return this.service.listCosts();
  }

  @ResponseMessage('Acquisition cost recorded.')
  @Post('acquisition-costs')
  addCost(@Body() dto: AddAcquisitionCostDto, @CurrentUser() admin: AuthUser) {
    return this.service.addCost(dto, admin.userId);
  }

  @Get(':section')
  section(@Param('section') section: string, @Query() q: AnalyticsQueryDto) {
    if (!(SECTIONS as string[]).includes(section)) throw new NotFoundException(`Unknown section "${section}". Use one of ${SECTIONS.join(', ')}`);
    return this.service.section(section as Section, q.from, q.to, q.refresh === true);
  }
}
