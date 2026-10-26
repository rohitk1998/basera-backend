import { Controller, Get, Query } from '@nestjs/common';
import { AttractionsService } from './attractions.service';

@Controller('api/attractions')
export class AttractionsController {
  constructor(private readonly attractions: AttractionsService) {}

  @Get()
  async forSearch(@Query() query: Record<string, unknown>) {
    const result = await this.attractions.forSearch(query ?? {});
    return { success: true, ...result };
  }
}
