import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AttractionsService } from './attractions.service';

@Controller('api/attractions')
export class AttractionsController {
  constructor(private readonly attractions: AttractionsService) {}

  @Get()
  async forSearch(@Query() query: Record<string, unknown>) {
    const result = await this.attractions.forSearch(query ?? {});
    return { success: true, ...result };
  }

  /** "Things to do nearby" for a stay page: the closest published attractions to lat/lng. */
  @Get('nearby')
  async nearby(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('limit') limit?: string,
    @Query('radiusKm') radiusKm?: string,
  ) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || la < 30 || la > 34 || ln < 75 || ln > 80) {
      throw new BadRequestException('lat/lng must be inside Himachal Pradesh');
    }
    const attractions = await this.attractions.nearby(la, ln, {
      limit: limit ? Number(limit) || undefined : undefined,
      radiusKm: radiusKm ? Number(radiusKm) || undefined : undefined,
    });
    return { success: true, attractions };
  }
}
