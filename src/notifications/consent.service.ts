import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConsentStatus, ContactChannel, ContactPreferenceEntity } from '../entities';

@Injectable()
export class ConsentService {
  constructor(
    @InjectRepository(ContactPreferenceEntity)
    private readonly prefs: Repository<ContactPreferenceEntity>,
  ) {}

  get(subjectType: string, subjectId: string, channel: ContactChannel): Promise<ContactPreferenceEntity | null> {
    return this.prefs.findOne({ where: { subject_type: subjectType, subject_id: subjectId, channel } });
  }

  /** All current preference rows for a subject, optionally one channel. */
  list(subjectType: string, subjectId: string, channel?: ContactChannel): Promise<ContactPreferenceEntity[]> {
    return this.prefs.find({
      where: { subject_type: subjectType, subject_id: subjectId, ...(channel ? { channel } : {}) },
      order: { channel: 'ASC' },
    });
  }

  async set(
    subjectType: string,
    subjectId: string,
    channel: ContactChannel,
    status: ConsentStatus,
    source?: string,
  ): Promise<void> {
    const now = new Date();
    await this.prefs.upsert(
      {
        subject_type: subjectType,
        subject_id: subjectId,
        channel,
        consent_status: status,
        source: source ?? null,
        consented_at: status === 'granted' ? now : null,
        revoked_at: status === 'revoked' ? now : null,
      },
      ['subject_type', 'subject_id', 'channel'],
    );
  }

  /** Only an explicit grant allows contact; 'unknown' and missing rows are treated as not allowed. */
  async isAllowed(subjectType: string, subjectId: string, channel: ContactChannel): Promise<boolean> {
    const row = await this.get(subjectType, subjectId, channel);
    return row?.consent_status === 'granted';
  }
}
