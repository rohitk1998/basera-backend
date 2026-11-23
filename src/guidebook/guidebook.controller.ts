import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { GuidebookService } from './guidebook.service';
import { UpdateGuidebookDto } from './dto/update-guidebook.dto';

@Controller('api')
@UseGuards(AuthGuard)
export class GuidebookController {
  constructor(private readonly guidebook: GuidebookService) {}

  @Get('host/listings/:id/guidebook')
  async getForHost(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const sections = await this.guidebook.getForHost(user.userId, id);
    return { success: true, sections };
  }

  @ResponseMessage('Guidebook saved.')
  @Put('host/listings/:id/guidebook')
  async save(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGuidebookDto,
  ) {
    const sections = await this.guidebook.saveForHost(user.userId, id, dto);
    return { success: true, sections };
  }

  @Get('guidebook/:listingId')
  async getForGuest(
    @CurrentUser() user: AuthUser,
    @Param('listingId', ParseUUIDPipe) listingId: string,
  ) {
    const sections = await this.guidebook.getForGuest(user.userId, listingId);
    return { success: true, sections };
  }
}
