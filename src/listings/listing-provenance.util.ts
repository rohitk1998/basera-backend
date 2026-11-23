import { BadRequestException } from '@nestjs/common';

export const PROVENANCE_SOURCES = ['host', 'admin', 'licensed', 'google_display_only'] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/** Fields a host authors (or an admin edits on their behalf). Third-party display-only content may never land here. */
export const HOST_AUTHORED_FIELDS = [
  'title',
  'description',
  'theSpace',
  'guestAccess',
  'photos',
  'amenities',
  'houseRules',
  'address',
  'pricing',
] as const;

export type ProvenanceRecord = {
  field: string;
  source: ProvenanceSource;
  capturedAt?: Date;
  permittedUntil?: Date | null;
  note?: string | null;
};

export function assertProvenanceAllowed(rec: ProvenanceRecord): void {
  if (!(PROVENANCE_SOURCES as readonly string[]).includes(rec.source)) {
    throw new BadRequestException(`Unknown content source "${rec.source}".`);
  }
  if (!rec.field || rec.field.length > 80) throw new BadRequestException('A field name is required.');
  if (rec.source === 'google_display_only') {
    if ((HOST_AUTHORED_FIELDS as readonly string[]).includes(rec.field)) {
      throw new BadRequestException(
        `Google display-only content cannot be saved into the host-authored field "${rec.field}".`,
      );
    }
    if (!rec.permittedUntil) {
      throw new BadRequestException('Google display-only content must carry a permitted_until date.');
    }
  }
}
