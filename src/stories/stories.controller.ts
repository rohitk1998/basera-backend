import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CreateStoryDto } from './dto/create-story.dto';
import { ModerateStoryDto } from './dto/moderate-story.dto';
import { StoryConsentDto } from './dto/story-consent.dto';
import { StoriesService } from './stories.service';

const notFoundOnBadId = new ParseUUIDPipe({ errorHttpStatusCode: 404 });

@Controller('api/stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Get()
  list(
    @Query('town') town?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.stories.listPublic({
      town,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      cursor,
    });
  }

  // Declared before ':id' so "mine" is not read as an id.
  @UseGuards(AuthGuard)
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.stories.listMine(user.userId);
  }

  @Get(':id')
  get(@Param('id', notFoundOnBadId) id: string) {
    return this.stories.getPublic(id);
  }

  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ResponseMessage('Thanks. Your story is with our team for review.')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStoryDto) {
    return this.stories.create(user.userId, dto);
  }

  @UseGuards(AuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage((_r, req) =>
    req.body?.marketingConsent
      ? 'Consent saved.'
      : 'Your story is no longer shown.',
  )
  @Patch(':id/consent')
  consent(
    @CurrentUser() user: AuthUser,
    @Param('id', notFoundOnBadId) id: string,
    @Body() dto: StoryConsentDto,
  ) {
    return this.stories.setConsent(user.userId, id, dto.marketingConsent);
  }
}

@Controller('api/admin/stories')
@UseGuards(AdminGuard)
export class AdminStoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.stories.listForAdmin(status);
  }

  @ResponseMessage((_r, req) =>
    req.body?.status === 'published' ? 'Story published.' : 'Story rejected.',
  )
  @Patch(':id')
  moderate(
    @Param('id', notFoundOnBadId) id: string,
    @Body() dto: ModerateStoryDto,
  ) {
    return this.stories.moderate(id, dto.status);
  }
}
