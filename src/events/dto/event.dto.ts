import type { EventEntity } from '../../entities';

export type EventDto = {
  id: string;
  slug: string;
  title: string;
  description: string;
  town: string;
  district: string;
  startsOn: string;
  endsOn: string;
  imageUrl: string | null;
};

export type AdminEventDto = EventDto & {
  status: 'draft' | 'published';
  lat: number | null;
  lng: number | null;
};

export function toEventDto(row: EventEntity): EventDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    town: row.town,
    district: row.district,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    imageUrl: row.image_url ?? null,
  };
}

export function toAdminEventDto(row: EventEntity): AdminEventDto {
  return {
    ...toEventDto(row),
    status: row.status,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
  };
}
