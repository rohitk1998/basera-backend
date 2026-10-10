import { Controller, Get, Query } from '@nestjs/common';
import { AttractionsService } from './attractions.service';

/**
 * Public, no auth. The /stays search page asks this with the same
 * district / tehsil / q it sends to GET /api/listings, and gets the
 * published attractions for that district (or an empty answer).
 */
@Controller('api/attractions')
export class AttractionsController {
  constructor(private readonly attractions: AttractionsService) {}

  @Get()
  async forSearch(@Query() query: Record<string, unknown>) {
    const result = await this.attractions.forSearch(query ?? {});
    return { success: true, ...result };
  }
}
