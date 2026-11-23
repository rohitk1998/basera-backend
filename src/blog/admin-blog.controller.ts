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
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { CreateBlogPostDto, UpdateBlogPostDto } from './dto/blog-write.dto';
import { BlogService } from './blog.service';

@Controller('api/admin/blog')
@UseGuards(AdminGuard)
export class AdminBlogController {
  constructor(private readonly blog: BlogService) {}

  @Get()
  async list() {
    const posts = await this.blog.listAdmin();
    return { success: true, posts };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const post = await this.blog.getAdmin(id);
    return { success: true, post };
  }

  @ResponseMessage('Post created.')
  @Post()
  async create(@Body() body: CreateBlogPostDto, @CurrentUser() user: AuthUser) {
    const post = await this.blog.create(body, user.userId);
    return { success: true, post };
  }

  @ResponseMessage('Post updated.')
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateBlogPostDto,
  ) {
    const post = await this.blog.update(id, body);
    return { success: true, post };
  }

  @ResponseMessage('Post deleted.')
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.blog.remove(id);
    return { success: true };
  }
}
