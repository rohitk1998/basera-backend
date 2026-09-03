import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { Amenity } from '../listings/listing.types';

/**
 * Cache-aside store of machine translations of a listing's free-text
 * fields into a guest's locale. Keyed on (listing_id, locale, content_hash)
 * so a host edit — which changes the hash — never serves a stale
 * translation; the old row is just never matched again.
 */
@Entity('listing_translations')
@Unique(['listing_id', 'locale', 'content_hash'])
@Index(['listing_id', 'locale', 'content_hash'])
export class ListingTranslationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  listing_id: string;

  @Column()
  locale: string;

  @Column()
  content_hash: string;

  @Column()
  source_locale: string;

  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  the_space: string | null;

  @Column({ type: 'text', nullable: true })
  guest_access: string | null;

  @Column('jsonb', { nullable: true })
  amenities: Amenity[] | null;

  @Column({ type: 'text', nullable: true })
  house_rules_check_in: string | null;

  @Column({ type: 'text', nullable: true })
  house_rules_check_out: string | null;

  @Column({ default: 'ready' })
  status: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
