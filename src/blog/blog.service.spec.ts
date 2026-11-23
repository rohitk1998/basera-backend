import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { BlogService } from './blog.service';
import { readingMinutes } from './dto/blog.dto';

const NOW = new Date('2026-11-16T10:00:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    slug: 'hello',
    title: 'Hello',
    excerpt: '',
    body_md: 'one two three',
    cover_image_url: null,
    cover_alt: null,
    category: null,
    tags: [],
    locale: 'en',
    seo_title: null,
    seo_description: null,
    status: 'draft',
    published_at: null,
    author_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makeService(opts: { found?: unknown; saves?: Array<unknown | Error>; deleted?: number } = {}) {
  const saves = [...(opts.saves ?? [])];
  const repo = {
    findOne: jest.fn().mockResolvedValue(opts.found ?? null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (v: Record<string, unknown>) => {
      const next = saves.shift();
      if (next instanceof Error) throw next;
      return next ?? row(v);
    }),
    delete: jest.fn().mockResolvedValue({ affected: opts.deleted ?? 1 }),
  };
  return { service: new BlogService(repo as never), repo };
}

const uniqueViolation = () => Object.assign(new Error('dup'), { code: '23505' });

describe('BlogService.create', () => {
  it('derives the slug from the title and defaults to draft', async () => {
    const { service, repo } = makeService();
    const post = await service.create({ title: 'Best Treks in Manali!' }, 'u1');
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ slug: 'best-treks-in-manali', status: 'draft', published_at: null, author_id: 'u1' }));
    expect(post.status).toBe('draft');
  });

  it('stamps published_at when created as published', async () => {
    const { service, repo } = makeService();
    await service.create({ title: 'Live', status: 'published' }, null);
    const saved = repo.save.mock.calls[0][0] as { published_at: Date | null };
    expect(saved.published_at).toBeInstanceOf(Date);
  });

  it('suffixes a derived slug that is taken', async () => {
    const { service, repo } = makeService({ saves: [uniqueViolation(), uniqueViolation()] });
    await service.create({ title: 'Same Title' }, null);
    expect(repo.save.mock.calls.map((c) => (c[0] as { slug: string }).slug)).toEqual(['same-title', 'same-title-2', 'same-title-3']);
  });

  it('409s when an explicit slug is taken', async () => {
    const { service } = makeService({ saves: [uniqueViolation()] });
    await expect(service.create({ title: 'X', slug: 'taken' }, null)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a title that yields no slug', async () => {
    const { service } = makeService();
    await expect(service.create({ title: '!!!' }, null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('dedupes and trims tags, and nulls blank optional strings', async () => {
    const { service, repo } = makeService();
    await service.create({ title: 'T', tags: [' a ', 'a', '', 'b'], category: '  ', coverImageUrl: null }, null);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ tags: ['a', 'b'], category: null, cover_image_url: null }));
  });

  it('rethrows non-unique database errors', async () => {
    const { service } = makeService({ saves: [new Error('boom')] });
    await expect(service.create({ title: 'T' }, null)).rejects.toThrow('boom');
  });
});

describe('BlogService.update', () => {
  it('404s for a missing post', async () => {
    const { service } = makeService();
    await expect(service.update('x', { title: 'a' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stamps published_at on first publish only', async () => {
    const first = row();
    const { service } = makeService({ found: first });
    await service.update('p1', { status: 'published' });
    const stamped = first.published_at as Date | null;
    expect(stamped).toBeInstanceOf(Date);

    await service.update('p1', { status: 'draft' });
    await service.update('p1', { status: 'published' });
    expect(first.published_at).toBe(stamped);
  });

  it('only touches the fields it was given', async () => {
    const existing = row({ title: 'Keep', excerpt: 'keep me' });
    const { service } = makeService({ found: existing });
    await service.update('p1', { bodyMd: 'new body' });
    expect(existing.title).toBe('Keep');
    expect(existing.excerpt).toBe('keep me');
    expect(existing.body_md).toBe('new body');
  });

  it('clears the cover image with null', async () => {
    const existing = row({ cover_image_url: 'https://x/y.png' });
    const { service } = makeService({ found: existing });
    await service.update('p1', { coverImageUrl: null });
    expect(existing.cover_image_url).toBeNull();
  });

  it('409s on a slug clash', async () => {
    const { service } = makeService({ found: row(), saves: [uniqueViolation()] });
    await expect(service.update('p1', { slug: 'dup' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BlogService.remove / getAdmin', () => {
  it('404s when nothing was deleted', async () => {
    const { service } = makeService({ deleted: 0 });
    await expect(service.remove('p1')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('404s for a missing admin post', async () => {
    const { service } = makeService();
    await expect(service.getAdmin('p1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BlogService.getPublicBySlug', () => {
  it('404s when the post is not published (drafts are never public)', async () => {
    const { service, repo } = makeService();
    await expect(service.getPublicBySlug('hello')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.findOne).toHaveBeenCalledWith({ where: { slug: 'hello', status: 'published' } });
  });
});

describe('readingMinutes', () => {
  it('is at least one minute', () => expect(readingMinutes('')).toBe(1));
  it('rounds by 200 wpm', () => expect(readingMinutes('word '.repeat(450))).toBe(2));
});

describe('BlogService.getPublicBySlug input guard', () => {
  it.each(['\u0000', 'Has Space', '../etc', 'a'.repeat(121), "x'; drop table--"])(
    'never queries the database for %j',
    async (slug) => {
      const { service, repo } = makeService();
      await expect(service.getPublicBySlug(slug)).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.findOne).not.toHaveBeenCalled();
    },
  );
});
