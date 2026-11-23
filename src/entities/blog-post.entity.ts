import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type BlogPostStatus = 'draft' | 'published';

@Entity('blog_posts')
export class BlogPostEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  slug: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text', default: '' })
  excerpt: string;

  @Column({ type: 'text', default: '' })
  body_md: string;

  @Column({ type: 'text', nullable: true })
  cover_image_url: string | null;

  @Column({ type: 'text', nullable: true })
  cover_alt: string | null;

  @Column({ type: 'text', nullable: true })
  category: string | null;

  @Column('text', { array: true, default: () => "'{}'" })
  tags: string[];

  @Column({ type: 'text', default: 'en' })
  locale: string;

  @Column({ type: 'text', nullable: true })
  seo_title: string | null;

  @Column({ type: 'text', nullable: true })
  seo_description: string | null;

  @Column({ type: 'text', default: 'draft' })
  status: BlogPostStatus;

  @Column({ type: 'timestamptz', nullable: true })
  published_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  author_id: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
