import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CreateEventDto, UpdateEventDto } from './dto/event-write.dto';
import { EventsService } from './events.service';

@Controller('api/admin/events')
@UseGuards(AdminGuard)
export class AdminEventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  async list() {
    const events = await this.events.listAdmin();
    return { success: true, events };
  }

  @ResponseMessage('Event created.')
  @Post()
  async create(@Body() body: CreateEventDto) {
    const event = await this.events.create(body);
    return { success: true, event };
  }

  @ResponseMessage('Event updated.')
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateEventDto,
  ) {
    const event = await this.events.update(id, body);
    return { success: true, event };
  }

  @ResponseMessage('Event deleted.')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.events.remove(id);
    return { success: true };
  }
}
