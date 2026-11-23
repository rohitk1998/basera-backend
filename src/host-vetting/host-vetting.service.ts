import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ListingEntity, UserEntity } from '../entities';
import { AddAuditDto, SetRatingDto } from './host-vetting.dto';
import { DEFAULT_AUDIT_STALE_DAYS, DEFAULT_DUE_LIMIT, DEFAULT_MIN_RATING } from './host-vetting.constants';
import { ListingAuditEntity } from './listing-audit.entity';
import { ListingVettingEntity } from './listing-vetting.entity';

type DueRow = {
  listing_id: string;
  title: string | null;
  status: string;
  last_audit_at: Date | null;
  last_outcome: string | null;
};

@Injectable()
export class HostVettingService {
  constructor(
    @InjectRepository(ListingVettingEntity) private readonly vetting: Repository<ListingVettingEntity>,
    @InjectRepository(ListingAuditEntity) private readonly audits: Repository<ListingAuditEntity>,
    @InjectRepository(ListingEntity) private readonly listings: Repository<ListingEntity>,
    private readonly config: ConfigService,
  ) {}

  private minRating(): number {
    const configured = Number(this.config.get('VETTING_MIN_RATING'));
    return Number.isFinite(configured) ? configured : DEFAULT_MIN_RATING;
  }

  private async assertListing(listingId: string) {
    if (!(await this.listings.exists({ where: { id: listingId } }))) {
      throw new NotFoundException('Listing not found.');
    }
  }

  private present(row: ListingVettingEntity | null) {
    const minRating = this.minRating();
    const rating = row?.external_rating == null ? null : Number(row.external_rating);
    return {
      rating,
      source: row?.external_rating_source ?? null,
      reviewCount: row?.external_review_count ?? null,
      url: row?.external_url ?? null,
      checkedBy: row?.checked_by ?? null,
      checkedAt: row?.checked_at ?? null,
      minRating,
      // Surfaced only: approval is deliberately not gated on this (product decision).
      meetsThreshold: rating === null ? null : rating >= minRating,
    };
  }

  async getVetting(listingId: string) {
    await this.assertListing(listingId);
    const [row, history] = await Promise.all([
      this.vetting.findOne({ where: { listing_id: listingId } }),
      this.audits.find({ where: { listing_id: listingId }, order: { created_at: 'DESC' } }),
    ]);
    const auditorIds = [...new Set(history.map((a) => a.auditor_id).filter((id): id is string => !!id))];
    const auditors = auditorIds.length
      ? await this.audits.manager.find(UserEntity, { where: { id: In(auditorIds) }, select: { id: true, full_name: true } })
      : [];
    const nameById = new Map(auditors.map((u) => [u.id, u.full_name]));
    return {
      rating: this.present(row),
      audits: history.map((a) => ({
        id: a.id,
        auditorId: a.auditor_id,
        auditorName: (a.auditor_id && nameById.get(a.auditor_id)) || null,
        outcome: a.outcome,
        note: a.note,
        createdAt: a.created_at,
      })),
    };
  }

  async setRating(listingId: string, adminId: string, dto: SetRatingDto) {
    await this.assertListing(listingId);
    await this.vetting.upsert(
      {
        listing_id: listingId,
        external_rating: dto.rating.toFixed(1),
        external_rating_source: dto.source,
        external_review_count: dto.reviewCount,
        external_url: dto.url ?? null,
        checked_by: adminId,
        checked_at: new Date(),
      },
      ['listing_id'],
    );
    return this.present(await this.vetting.findOne({ where: { listing_id: listingId } }));
  }

  async addAudit(listingId: string, adminId: string, dto: AddAuditDto) {
    await this.assertListing(listingId);
    const saved = await this.audits.save(
      this.audits.create({ listing_id: listingId, auditor_id: adminId, outcome: dto.outcome, note: dto.note.trim() }),
    );
    return { id: saved.id, auditorId: saved.auditor_id, outcome: saved.outcome, note: saved.note, createdAt: saved.created_at };
  }

  /**
   * Live listings with no audit, or whose latest audit is older than `days`.
   * Order: never audited first, then oldest audit; ties by newest listing then id, so paging is stable.
   */
  async listDue(days = DEFAULT_AUDIT_STALE_DAYS, limit = DEFAULT_DUE_LIMIT, offset = 0) {
    const from = `FROM listings l
         LEFT JOIN LATERAL (
           SELECT created_at, outcome FROM listing_audits
            WHERE listing_id = l.id ORDER BY created_at DESC LIMIT 1
         ) a ON true
        WHERE l.status = 'live'
          AND l.is_discovered = false
          AND (a.created_at IS NULL OR a.created_at < now() - make_interval(days => $1))`;
    const rows: DueRow[] = await this.listings.query(
      `SELECT l.id AS listing_id,
              l.draft_data->'property_details'->>'title' AS title,
              l.status,
              a.created_at AS last_audit_at,
              a.outcome AS last_outcome
         ${from}
        ORDER BY a.created_at ASC NULLS FIRST, l.created_at DESC, l.id ASC
        LIMIT $2 OFFSET $3`,
      [days, limit, offset],
    );
    const counted: { total: string }[] = await this.listings.query(`SELECT count(*)::text AS total ${from}`, [days]);
    const total = Number(counted[0]?.total ?? 0);
    return {
      days,
      total,
      limit,
      offset,
      properties: rows.map((r) => ({
        listingId: r.listing_id,
        title: r.title ?? 'Untitled listing',
        status: r.status,
        lastAuditAt: r.last_audit_at,
        lastOutcome: r.last_outcome,
      })),
    };
  }
}
