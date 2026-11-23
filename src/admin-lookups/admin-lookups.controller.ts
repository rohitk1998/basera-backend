import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { ConsentQueryDto, UserLookupDto } from './admin-lookups.dto';
import { AdminLookupsService } from './admin-lookups.service';

const READ = { default: { ttl: 60_000, limit: 120 } };

@Controller('api/admin')
@UseGuards(AdminGuard)
export class AdminLookupsController {
  constructor(private readonly service: AdminLookupsService) {}

  @Throttle(READ) @Get('staff')
  staff() {
    return this.service.staff();
  }

  @Throttle(READ) @Get('consent')
  consent(@Query() q: ConsentQueryDto) {
    return this.service.consentFor(q.subjectType, q.subjectId, q.channel);
  }

  @Throttle(READ) @Get('users/lookup')
  users(@Query() q: UserLookupDto) {
    return this.service.users(q.ids);
  }
}
