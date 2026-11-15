import { Controller, Get, Param, Query } from '@nestjs/common';
import { EventsService } from './events.service';
import { ListEventsQueryDto } from './dto/list-events.dto';

@Controller('api/events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  async list(@Query() query: ListEventsQueryDto) {
    const events = await this.events.listPublic(query);
    return { success: true, events };
  }

  @Get(':slug')
  async bySlug(@Param('slug') slug: string) {
    const event = await this.events.getPublicBySlug(slug);
    return { success: true, event };
  }
}
