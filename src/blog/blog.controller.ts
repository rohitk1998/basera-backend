import { Controller, Get, Param, Query } from '@nestjs/common';
import { BlogService } from './blog.service';
import { ListBlogQueryDto } from './dto/list-blog.dto';

@Controller('api/blog')
export class BlogController {
  constructor(private readonly blog: BlogService) {}

  @Get()
  async list(@Query() query: ListBlogQueryDto) {
    const result = await this.blog.listPublic(query);
    return { success: true, ...result };
  }

  @Get(':slug')
  async bySlug(@Param('slug') slug: string) {
    const { post, related } = await this.blog.getPublicBySlug(slug);
    return { success: true, post, related };
  }
}
