import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';

// Unauthenticated, unthrottled, and deliberately terse: only {status} is ever returned,
// never error text, hostnames or versions.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  @Get()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.dataSource.query('select 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    // RedisService swallows command errors and set() reports success as a boolean, so a short-TTL
    // write doubles as a reachability ping without touching RedisService itself.
    if (!(await this.redis.set('health:ping', '1', 10))) {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
    return { status: 'ok' };
  }
}
