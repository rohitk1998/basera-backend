import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { HP_DISTRICTS, type HpDistrict } from '../listings/hp-locations';
import { AttractionsImportService } from './attractions-import.service';
import { AttractionsService } from './attractions.service';

@Controller('api/admin/attractions')
@UseGuards(AdminGuard)
export class AdminAttractionsController {
  constructor(
    private readonly attractions: AttractionsService,
    private readonly importer: AttractionsImportService,
  ) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const result = await this.attractions.adminList(query ?? {});
    return {
      success: true,
      ...result,
      importConfigured: this.importer.isConfigured(),
    };
  }

  @Get('import')
  importStatus() {
    return {
      success: true,
      status: this.importer.getStatus(),
      configured: this.importer.isConfigured(),
    };
  }

  @ResponseMessage('Import started. New places arrive as drafts.')
  @Post('import')
  startImport(@Body() body: { district?: unknown }) {
    const district = (HP_DISTRICTS as readonly string[]).includes(
      String(body?.district),
    )
      ? (body.district as HpDistrict)
      : undefined;
    const status = this.importer.start({ district });
    return { success: true, status };
  }

  @Get('youtube')
  async youtube(@Query('q') q: unknown) {
    const videos = await this.attractions.youtubeSearch(q);
    return { success: true, videos };
  }

  @ResponseMessage(
    (r: { imageWarning?: string }) => r?.imageWarning ?? 'Place added.',
  )
  @Post()
  async create(@Body() body: unknown) {
    return { success: true, ...(await this.attractions.create(body)) };
  }

  @ResponseMessage(
    (r: { imageWarning?: string }) => r?.imageWarning ?? 'Place updated.',
  )
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return { success: true, ...(await this.attractions.update(id, body)) };
  }

  @ResponseMessage('Place deleted.')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return { success: true, ...(await this.attractions.remove(id)) };
  }
}
