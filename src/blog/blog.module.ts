import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlogPostEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { BlogController } from './blog.controller';
import { AdminBlogController } from './admin-blog.controller';
import { BlogMediaController } from './blog-media.controller';
import { BlogService } from './blog.service';

@Module({
  imports: [TypeOrmModule.forFeature([BlogPostEntity]), AuthModule],
  controllers: [BlogController, AdminBlogController, BlogMediaController],
  providers: [BlogService],
  exports: [BlogService],
})
export class BlogModule {}
