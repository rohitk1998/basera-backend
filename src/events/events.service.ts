import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEntity } from '../entities';
import {
  AdminEventDto,
  EventDto,
  toAdminEventDto,
  toEventDto,
} from './dto/event.dto';
import { CreateEventDto, UpdateEventDto } from './dto/event-write.dto';
import { ListEventsQueryDto } from './dto/list-events.dto';

const DEFAULT_LIMIT = 20;
const PG_UNIQUE_VIOLATION = '23505';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Calendar date in India, so "today" does not roll over at 05:30 local time.
function todayInIndia(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly events: Repository<EventEntity>,
  ) {}

  /**
   * Published events that have not ended before `from` (default today), soonest
   * first. An event still running on `from` counts as upcoming.
   */
  async listPublic(query: ListEventsQueryDto): Promise<EventDto[]> {
    const qb = this.events
      .createQueryBuilder('e')
      .where('e.status = :status', { status: 'published' })
      .andWhere('e.ends_on >= :from', { from: query.from ?? todayInIndia() })
      .orderBy('e.starts_on', 'ASC')
      .addOrderBy('e.title', 'ASC')
      .limit(query.limit ?? DEFAULT_LIMIT);
    const town = query.town?.trim();
    if (town) qb.andWhere('LOWER(e.town) = LOWER(:town)', { town });
    const rows = await qb.getMany();
    return rows.map(toEventDto);
  }

  async getPublicBySlug(slug: string): Promise<EventDto> {
    const row = await this.events.findOne({
      where: { slug, status: 'published' },
    });
    if (!row) throw new NotFoundException('Event not found.');
    return toEventDto(row);
  }

  async listAdmin(): Promise<AdminEventDto[]> {
    const rows = await this.events.find({
      order: { starts_on: 'ASC', title: 'ASC' },
    });
    return rows.map(toAdminEventDto);
  }

  async create(dto: CreateEventDto): Promise<AdminEventDto> {
    this.assertDateOrder(dto.startsOn, dto.endsOn);
    const slug = dto.slug ?? slugify(dto.title);
    if (!slug)
      throw new BadRequestException('Could not build a slug from the title.');
    try {
      const saved = await this.events.save(
        this.events.create({
          slug,
          title: dto.title.trim(),
          description: dto.description.trim(),
          town: dto.town.trim(),
          district: dto.district.trim(),
          starts_on: dto.startsOn,
          ends_on: dto.endsOn,
          lat: dto.lat ?? null,
          lng: dto.lng ?? null,
          image_url: dto.imageUrl ?? null,
          status: dto.status ?? 'draft',
        }),
      );
      return toAdminEventDto(saved);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async update(id: string, dto: UpdateEventDto): Promise<AdminEventDto> {
    const row = await this.events.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Event not found.');

    const startsOn = dto.startsOn ?? row.starts_on;
    const endsOn = dto.endsOn ?? row.ends_on;
    this.assertDateOrder(startsOn, endsOn);

    if (dto.slug !== undefined) row.slug = dto.slug;
    if (dto.title !== undefined) row.title = dto.title.trim();
    if (dto.description !== undefined) row.description = dto.description.trim();
    if (dto.town !== undefined) row.town = dto.town.trim();
    if (dto.district !== undefined) row.district = dto.district.trim();
    row.starts_on = startsOn;
    row.ends_on = endsOn;
    if (dto.lat !== undefined) row.lat = dto.lat;
    if (dto.lng !== undefined) row.lng = dto.lng;
    if (dto.imageUrl !== undefined) row.image_url = dto.imageUrl;
    if (dto.status !== undefined) row.status = dto.status;

    try {
      return toAdminEventDto(await this.events.save(row));
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.events.delete({ id });
    if (!result.affected) throw new NotFoundException('Event not found.');
  }

  private assertDateOrder(startsOn: string, endsOn: string): void {
    if (endsOn < startsOn) {
      throw new BadRequestException('endsOn cannot be before startsOn.');
    }
  }

  private mapWriteError(err: unknown): unknown {
    const code = (err as { code?: string } | null)?.code;
    if (code === PG_UNIQUE_VIOLATION) {
      return new ConflictException('An event with this slug already exists.');
    }
    return err;
  }
}
