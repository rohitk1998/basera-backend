import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('listing_calendar_sync')
export class ListingCalendarSyncEntity {
  @PrimaryColumn('uuid')
  listing_id: string;

  /** Secret in the public .ics export URL. Rotating it invalidates the old URL. */
  @Column({ type: 'text' })
  export_token: string;

  @Column({ type: 'text', nullable: true })
  import_url: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_synced_at: Date | null;

  @Column({ type: 'text', nullable: true })
  last_sync_error: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
