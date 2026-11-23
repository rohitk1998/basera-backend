import { Column, Entity, PrimaryColumn } from 'typeorm';

export type GuidebookSection = { title: string; body: string };

@Entity('guidebooks')
export class GuidebookEntity {
  @PrimaryColumn('uuid')
  listing_id: string;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  sections: GuidebookSection[];

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updated_at: Date;
}
