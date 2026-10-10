import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type {
  AttractionCategory,
  AttractionDifficulty,
  AttractionStatus,
} from '../attractions/attraction.types';

/** A place to visit near stays — see migrations/20261001_attractions.sql. */
@Entity('attractions')
export class AttractionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  slug: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  category: AttractionCategory;

  @Column({ type: 'text' })
  district: string;

  @Column({ type: 'text', nullable: true })
  tehsil: string | null;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lng: number;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  image_url: string | null;

  @Column({ type: 'text', nullable: true })
  image_credit: string | null;

  @Column({ type: 'text', nullable: true })
  difficulty: AttractionDifficulty | null;

  @Column({ type: 'text', nullable: true })
  duration: string | null;

  // numeric comes back from pg as a string; the transformer keeps it a number.
  @Column({
    type: 'numeric',
    precision: 6,
    scale: 1,
    nullable: true,
    transformer: {
      to: (v: number | null) => v,
      from: (v: string | null) => (v === null ? null : Number(v)),
    },
  })
  distance_km: number | null;

  @Column({ type: 'text', nullable: true })
  best_season: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  youtube_ids: string[];

  @Column({ type: 'smallint', default: 0 })
  popularity: number;

  @Column({ type: 'text' })
  source: 'wikidata' | 'manual';

  @Column({ type: 'text', nullable: true })
  source_id: string | null;

  @Column({ type: 'text', nullable: true })
  wikipedia_url: string | null;

  @Column({ type: 'text', default: 'draft' })
  status: AttractionStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
