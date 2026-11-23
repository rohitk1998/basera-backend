import type { InquiryState } from '../inquiries/inquiry.types';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Non-binding guest request. Never a booking, never a payment. */
@Entity('inquiries')
export class InquiryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', unique: true })
  public_ref: string;

  /** sha256 of the guest access token; the token itself is never stored. */
  @Column({ type: 'text' })
  access_token_hash: string;

  @Column('uuid', { nullable: true })
  guest_user_id: string | null;

  @Column({ type: 'text' })
  guest_name: string;

  @Column({ type: 'text' })
  guest_phone: string;

  @Column({ type: 'text', nullable: true })
  guest_email: string | null;

  @Column('uuid', { nullable: true })
  target_listing_id: string | null;

  /** Possibly a discovered (unclaimed) listing. Server-side only: never serialised to a guest. */
  @Column('uuid', { nullable: true })
  candidate_listing_id: string | null;

  @Column({ type: 'text', nullable: true })
  destination: string | null;

  @Column({ type: 'date', nullable: true })
  check_in: string | null;

  @Column({ type: 'date', nullable: true })
  check_out: string | null;

  @Column({ type: 'int', nullable: true })
  guests: number | null;

  @Column({ type: 'int', nullable: true })
  budget_min: number | null;

  @Column({ type: 'int', nullable: true })
  budget_max: number | null;

  @Column({ type: 'text', nullable: true })
  requirements: string | null;

  @Column({ type: 'boolean' })
  consent_contact: boolean;

  @Column({ type: 'timestamptz' })
  consent_at: Date;

  @Column({ type: 'text' })
  consent_text_version: string;

  @Index()
  @Column({ type: 'text', default: 'NEW' })
  state: InquiryState;

  @Column('uuid', { nullable: true })
  assigned_to: string | null;

  @Column({ type: 'timestamptz' })
  response_due_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  first_response_at: Date | null;

  @Column({ type: 'boolean', default: false })
  offer_pending: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  offer_sent_at: Date | null;

  @Column('uuid', { nullable: true })
  converted_booking_id: string | null;

  @Column({ type: 'text', unique: true })
  dedupe_key: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
