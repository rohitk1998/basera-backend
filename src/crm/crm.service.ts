import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { ConsentService } from '../notifications/consent.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { applyOptOutByPhone, rowsOf, syncDiscoveryState } from './crm-sql';
import { HOST_INVITATION_EVENT } from './crm-email';
import { FollowUpTaskEntity, HostInvitationEntity, HostLeadEntity, OutreachAttemptEntity } from './crm.entities';
import { normalizePhone } from './crm.phone';
import { claimUrl, generateInviteToken, hashInviteToken } from './crm.tokens';
import {
  canTransition, computeFunnel, ContactState, STAGE_COLUMN,
} from './crm.types';
import type {
  AnalyticsQueryDto, CompleteTaskDto, CreateInvitationDto, CreateLeadDto, HostRegistrationDto, HostResponseDto,
  ListLeadsQueryDto, LogAttemptDto, RecordConsentDto, ScheduleTaskDto, UpdateLeadDto,
} from './dto/crm.dto';

const DAY = 86_400_000;
const CLOSED_STATES: ContactState[] = ['CONVERTED', 'DECLINED', 'DO_NOT_CONTACT'];

export type SendGate = { ok: true } | { ok: false; reason: string };

const OUTCOME_TO_STATE: Record<string, ContactState | null> = {
  no_answer: 'CONTACT_ATTEMPTED',
  wrong_number: 'CONTACT_ATTEMPTED',
  connected: 'CONTACTED',
  call_back: 'CONTACTED',
  interested: 'INTERESTED',
  not_interested: 'DECLINED',
  do_not_contact: 'DO_NOT_CONTACT',
};

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    @InjectRepository(HostLeadEntity) private readonly leads: Repository<HostLeadEntity>,
    @InjectRepository(OutreachAttemptEntity) private readonly attempts: Repository<OutreachAttemptEntity>,
    @InjectRepository(HostInvitationEntity) private readonly invites: Repository<HostInvitationEntity>,
    @InjectRepository(FollowUpTaskEntity) private readonly tasks: Repository<FollowUpTaskEntity>,
    private readonly db: DataSource,
    private readonly consent: ConsentService,
    private readonly whatsapp: WhatsappService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private get appUrl(): string {
    return this.config.get<string>('APP_URL') || 'https://www.rhenbasera.online';
  }

  // ---------- consent gate (service layer; UI is not trusted) ----------

  /**
   * Automated sends (email / whatsapp) need: lead not DO_NOT_CONTACT AND a recorded, granted consent for that
   * channel. A phone/email scraped from a public source never authorises sending by itself. Self-registered
   * hosts get consent recorded at registration (explicit checkbox), so they pass through the same rule.
   */
  async canAutoSend(lead: HostLeadEntity, channel: 'email' | 'whatsapp'): Promise<SendGate> {
    if (lead.contact_state === 'DO_NOT_CONTACT') return { ok: false, reason: 'lead is marked do-not-contact' };
    if (lead.contact_state === 'CONVERTED') return { ok: false, reason: 'lead already converted' };
    if (channel === 'email' && !lead.email) return { ok: false, reason: 'no email on file' };
    if (channel === 'whatsapp' && !normalizePhone(lead.phone)) return { ok: false, reason: 'no valid phone on file' };
    const allowed = await this.consent.isAllowed('host_lead', lead.id, channel);
    if (!allowed) return { ok: false, reason: `no recorded ${channel} consent (public-source contact details do not authorise sending)` };
    return { ok: true };
  }

  async recordConsent(leadId: string, dto: RecordConsentDto, staffId: string) {
    const lead = await this.mustGet(leadId);
    if (lead.contact_state === 'DO_NOT_CONTACT' && dto.granted) {
      throw new ForbiddenException('Lead opted out; consent cannot be re-granted by staff.');
    }
    const status = dto.granted ? 'granted' : 'revoked';
    await this.consent.set('host_lead', lead.id, dto.channel, status, `staff:${staffId}:${dto.evidence}`);
    const phone = normalizePhone(lead.phone);
    if (dto.channel === 'whatsapp' && phone) await this.consent.set('phone', phone, 'whatsapp', status, `lead:${lead.id}`);
    await this.attempts.insert({
      lead_id: lead.id, channel: dto.channel, direction: 'outbound', status: 'consent',
      outcome: `consent_${status}`, payload: { evidence: dto.evidence }, created_by: staffId,
    });
    return { leadId: lead.id, channel: dto.channel, status };
  }

  // ---------- leads ----------

  private async mustGet(id: string): Promise<HostLeadEntity> {
    const lead = await this.leads.findOne({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async createLead(dto: CreateLeadDto, staffId: string | null) {
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone && !phone) throw new BadRequestException('phone must be a valid phone number');
    if (!dto.listingId && !phone && !dto.email) throw new BadRequestException('Provide a listingId, phone or email');
    if (dto.listingId) {
      const rows = await this.db.query(`SELECT 1 FROM listings WHERE id = $1 AND is_discovered = true`, [dto.listingId]);
      if (!rows.length) throw new NotFoundException('Discovery candidate not found');
      if (await this.leads.findOne({ where: { listing_id: dto.listingId } })) throw new ConflictException('A lead already exists for this candidate');
    }
    const lead = await this.leads.save(this.leads.create({
      listing_id: dto.listingId ?? null,
      phone, email: dto.email?.toLowerCase() ?? null,
      contact_name: dto.contactName ?? null,
      property_hint: dto.propertyHint ?? null,
      source: dto.source,
      owner_staff_id: dto.ownerStaffId ?? null,
      next_action_at: dto.nextActionAt ? new Date(dto.nextActionAt) : null,
      notes: dto.notes ?? null,
      created_by: staffId,
      contact_state: 'NOT_CONTACTED',
    }));
    return lead;
  }

  async listLeads(q: ListLeadsQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const qb = this.leads.createQueryBuilder('l');
    if (q.state) qb.andWhere('l.contact_state = :state', { state: q.state });
    if (q.assignee) qb.andWhere('l.owner_staff_id = :a', { a: q.assignee });
    if (q.source) qb.andWhere('l.source = :src', { src: q.source });
    if (q.overdue) qb.andWhere('l.next_action_at IS NOT NULL AND l.next_action_at < now()').andWhere('l.contact_state NOT IN (:...closed)', { closed: CLOSED_STATES });
    if (q.q) {
      qb.andWhere('(l.contact_name ILIKE :s OR l.email ILIKE :s OR l.phone ILIKE :s OR l.property_hint ILIKE :s)', { s: `%${q.q.replace(/[%_]/g, '\\$&')}%` });
    }
    qb.orderBy('l.updated_at', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [rows, total] = await qb.getManyAndCount();
    const ownerIds = [...new Set(rows.map((r) => r.owner_staff_id).filter(Boolean))] as string[];
    const listingIds = [...new Set(rows.map((r) => r.listing_id).filter(Boolean))] as string[];
    const [owners, listings] = await Promise.all([
      ownerIds.length ? this.db.query(`SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`, [ownerIds]) : [],
      listingIds.length ? this.db.query(`SELECT id, discovery_destination, discovery_state FROM listings WHERE id = ANY($1::uuid[])`, [listingIds]) : [],
    ]);
    const ownerBy = new Map<string, any>((owners as any[]).map((o) => [o.id, o]));
    const listingBy = new Map<string, any>((listings as any[]).map((l) => [l.id, l]));
    const items = rows.map((r) => ({
      ...r,
      owner: r.owner_staff_id ? { id: r.owner_staff_id, name: ownerBy.get(r.owner_staff_id)?.full_name ?? null } : null,
      listing: r.listing_id && listingBy.get(r.listing_id)
        ? { id: r.listing_id, destination: listingBy.get(r.listing_id).discovery_destination ?? null, discovery_state: listingBy.get(r.listing_id).discovery_state ?? null }
        : null,
    }));
    return { items, total, page, pageSize };
  }

  async getLead(id: string) {
    const lead = await this.mustGet(id);
    const [attempts, tasks, invitations] = await Promise.all([
      this.attempts.find({ where: { lead_id: id }, order: { at: 'DESC' }, take: 100 }),
      this.tasks.find({ where: { lead_id: id }, order: { due_at: 'DESC' }, take: 50 }),
      this.invites.find({ where: { lead_id: id }, order: { created_at: 'DESC' }, take: 20 }),
    ]);
    return {
      lead, attempts, tasks,
      invitations: invitations.map(({ token_hash: _h, ...rest }) => rest),
    };
  }

  async updateLead(id: string, dto: UpdateLeadDto, staffId: string) {
    const lead = await this.mustGet(id);
    if (dto.phone !== undefined) {
      const p = normalizePhone(dto.phone);
      if (!p) throw new BadRequestException('phone must be a valid phone number');
      lead.phone = p;
    }
    if (dto.email !== undefined) lead.email = dto.email.toLowerCase();
    if (dto.contactName !== undefined) lead.contact_name = dto.contactName;
    if (dto.propertyHint !== undefined) lead.property_hint = dto.propertyHint;
    if (dto.notes !== undefined) lead.notes = dto.notes;
    if (dto.nextActionAt !== undefined) lead.next_action_at = new Date(dto.nextActionAt);
    if (dto.contactState && dto.contactState !== lead.contact_state) {
      if (dto.contactState === 'CONVERTED') throw new BadRequestException('CONVERTED is set only when a claim is approved');
      this.assertTransition(lead.contact_state, dto.contactState);
      await this.applyState(lead, dto.contactState);
    } else {
      lead.updated_at = new Date();
      await this.leads.save(lead);
    }
    this.logger.log(`lead ${id} updated by ${staffId}`);
    return this.mustGet(id);
  }

  async assign(id: string, staffId: string | null) {
    const lead = await this.mustGet(id);
    lead.owner_staff_id = staffId ?? null;
    lead.updated_at = new Date();
    await this.leads.save(lead);
    if (staffId) {
      await this.tasks.update({ lead_id: id, done_at: IsNull(), assignee_id: IsNull() }, { assignee_id: staffId });
    }
    return lead;
  }

  private assertTransition(from: ContactState, to: ContactState) {
    if (!canTransition(from, to)) throw new BadRequestException(`Illegal lead transition ${from} -> ${to}`);
  }

  /** Persist a state change, stamp the first-reached timestamp, and sync discovery_state. Caller validated the transition. */
  private async applyState(lead: HostLeadEntity, to: ContactState) {
    const col = STAGE_COLUMN[to];
    const now = new Date();
    lead.contact_state = to;
    lead.updated_at = now;
    if (col && !(lead as any)[col]) (lead as any)[col] = now;
    if (to === 'DO_NOT_CONTACT' || to === 'DECLINED' || to === 'CONVERTED') lead.next_action_at = null;
    await this.leads.save(lead);
    await syncDiscoveryState(this.db, lead.listing_id, to);
  }

  // ---------- outreach logging ----------

  /** Manual outreach log (calls, visits, etc.). Allowed regardless of consent; never sends anything. */
  async logAttempt(leadId: string, dto: LogAttemptDto, staffId: string) {
    const lead = await this.mustGet(leadId);
    const direction = dto.direction ?? 'outbound';
    if (lead.contact_state === 'DO_NOT_CONTACT' && direction === 'outbound') {
      throw new ForbiddenException('Lead is do-not-contact; outbound outreach cannot be logged.');
    }
    const attempt = await this.attempts.save(this.attempts.create({
      lead_id: lead.id, channel: dto.channel, direction, status: 'logged', outcome: dto.outcome,
      payload: { note: dto.note ?? null, manual: true }, created_by: staffId,
    }));
    const target = OUTCOME_TO_STATE[dto.outcome];
    let advancedTo: ContactState | null = null;
    if (target && target !== lead.contact_state && canTransition(lead.contact_state, target)) {
      await this.applyState(lead, target);
      advancedTo = target;
    }
    if (dto.outcome === 'do_not_contact') await this.finishOptOut(lead);
    if (dto.outcome !== 'wrong_number' && dto.outcome !== 'no_answer') lead.last_contacted_at = new Date();
    if (dto.nextActionAt) lead.next_action_at = new Date(dto.nextActionAt);
    lead.updated_at = new Date();
    await this.leads.save(lead);
    return { attempt, contactState: lead.contact_state, advancedTo };
  }

  async recordResponse(leadId: string, dto: HostResponseDto, staffId: string) {
    const outcome = ({ interested: 'interested', declined: 'not_interested', do_not_contact: 'do_not_contact', call_back: 'call_back' } as const)[dto.response];
    return this.logAttempt(leadId, { channel: 'call', direction: 'inbound', outcome, note: dto.note, nextActionAt: dto.nextActionAt }, staffId);
  }

  // ---------- opt-out ----------

  private async finishOptOut(lead: HostLeadEntity) {
    for (const ch of ['email', 'whatsapp', 'sms'] as const) await this.consent.set('host_lead', lead.id, ch, 'revoked', 'opt_out');
    const phone = normalizePhone(lead.phone);
    if (phone) await this.consent.set('phone', phone, 'whatsapp', 'revoked', 'opt_out');
    await this.invites.update({ lead_id: lead.id, used_at: IsNull(), revoked_at: IsNull() }, { revoked_at: new Date() });
    await this.tasks.update({ lead_id: lead.id, done_at: IsNull() }, { done_at: new Date(), note: 'closed: opted out' });
  }

  async doNotContact(leadId: string, staffId: string | null, source = 'staff') {
    const lead = await this.mustGet(leadId);
    if (lead.contact_state !== 'DO_NOT_CONTACT') {
      await this.applyState(lead, 'DO_NOT_CONTACT');
      await this.attempts.insert({ lead_id: lead.id, channel: 'call', direction: 'inbound', status: 'logged', outcome: 'opt_out', payload: { source }, created_by: staffId });
    }
    await this.finishOptOut(lead);
    return { leadId, contactState: 'DO_NOT_CONTACT' as const };
  }

  /** Public opt-out via invitation token (works for expired/used tokens too: opting out must always succeed). */
  async optOutByToken(token: string) {
    const inv = await this.invites.findOne({ where: { token_hash: hashInviteToken(token) } });
    if (inv) await this.doNotContact(inv.lead_id, null, 'invitation_link');
    return { ok: true }; // identical response whether or not the token matched
  }

  /** STOP hook for inbound channels (WhatsApp checker calls the SQL twin of this). */
  handleStop(phone: string, source = 'inbound_stop') {
    const p = normalizePhone(phone);
    return p ? applyOptOutByPhone(this.db, p, source) : Promise.resolve(0);
  }

  // ---------- follow-ups ----------

  async scheduleTask(leadId: string, dto: ScheduleTaskDto, staffId: string) {
    const lead = await this.mustGet(leadId);
    if (CLOSED_STATES.includes(lead.contact_state)) throw new BadRequestException(`Cannot schedule follow-ups on a ${lead.contact_state} lead`);
    return this.tasks.save(this.tasks.create({
      lead_id: lead.id, due_at: new Date(dto.dueAt),
      assignee_id: dto.assigneeId ?? lead.owner_staff_id ?? staffId,
      kind: dto.kind ?? 'call', note: dto.note ?? null,
    }));
  }

  async completeTask(taskId: string, dto: CompleteTaskDto, staffId: string) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.done_at) throw new ConflictException('Task already completed');
    task.done_at = new Date();
    task.done_by = staffId;
    if (dto.note) task.note = [task.note, dto.note].filter(Boolean).join(' | ');
    await this.tasks.save(task);
    // Clear the lead's trigger so the sweep does not immediately re-create the same task.
    await this.leads.update({ id: task.lead_id }, { next_action_at: dto.nextActionAt ? new Date(dto.nextActionAt) : null, updated_at: new Date() });
    return task;
  }

  async myTasks(staffId: string, scope: 'today' | 'overdue' | 'all' = 'today', now = new Date()) {
    const endOfToday = endOfDayIST(now);
    const qb = this.tasks.createQueryBuilder('t')
      .innerJoin(HostLeadEntity, 'l', 'l.id = t.lead_id')
      .addSelect(['l.contact_name', 'l.phone', 'l.property_hint', 'l.contact_state'])
      .where('t.assignee_id = :s AND t.done_at IS NULL', { s: staffId });
    if (scope === 'overdue') qb.andWhere('t.due_at < :now', { now });
    else if (scope === 'today') qb.andWhere('t.due_at <= :eod', { eod: endOfToday });
    const rows = await qb.orderBy('t.due_at', 'ASC').limit(200).getMany();
    const ids = [...new Set(rows.map((t) => t.lead_id))];
    const leadRows = ids.length ? await this.leads.find({ where: { id: In(ids) } }) : [];
    const leadBy = new Map(leadRows.map((l) => [l.id, l]));
    return rows.map((t) => {
      const l = leadBy.get(t.lead_id);
      return {
        ...t,
        overdue: t.due_at < now,
        lead: l ? { id: l.id, name: l.contact_name ?? null, phone: l.phone ?? null, state: l.contact_state, propertyHint: l.property_hint ?? null } : null,
      };
    });
  }

  /** Scheduler body: one open task per lead whose next_action_at has passed. Idempotent. Returns tasks created. */
  async sweepFollowUps(): Promise<number> {
    const rows = await this.db.query(
      `INSERT INTO follow_up_tasks (lead_id, due_at, assignee_id, kind, note)
         SELECT l.id, l.next_action_at, l.owner_staff_id, 'follow_up', 'auto: next action due'
           FROM host_leads l
          WHERE l.next_action_at IS NOT NULL AND l.next_action_at <= now()
            AND l.contact_state NOT IN ('CONVERTED','DECLINED','DO_NOT_CONTACT')
            AND NOT EXISTS (SELECT 1 FROM follow_up_tasks t WHERE t.lead_id = l.id AND t.done_at IS NULL)
       RETURNING id`,
    );
    return rowsOf(rows).length;
  }

  // ---------- invitations ----------

  async createInvitation(leadId: string, dto: CreateInvitationDto, staffId: string, resendOf?: HostInvitationEntity) {
    const lead = await this.mustGet(leadId);
    if (lead.contact_state === 'DO_NOT_CONTACT') throw new ForbiddenException('Lead is do-not-contact.');
    if (lead.contact_state === 'CONVERTED') throw new BadRequestException('Lead already converted.');
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + (dto.ttlDays ?? 14) * DAY);
    // one live invitation per lead: older unused ones are revoked, their links stop working
    await this.invites.update({ lead_id: lead.id, used_at: IsNull(), revoked_at: IsNull() }, { revoked_at: new Date() });

    const link = claimUrl(this.appUrl, token);
    const delivery = await this.deliverInvitation(lead, dto.channel ?? 'auto', link, expiresAt);
    const invitation = await this.invites.save(this.invites.create({
      lead_id: lead.id, token_hash: hashInviteToken(token), expires_at: expiresAt, created_by: staffId,
      channel: delivery.channel, resend_count: resendOf ? resendOf.resend_count + 1 : 0,
    }));
    await this.attempts.insert({
      lead_id: lead.id, channel: delivery.channel === 'manual' ? 'call' : delivery.channel, direction: 'outbound',
      template: delivery.channel === 'whatsapp' ? 'host_invitation' : delivery.channel === 'email' ? HOST_INVITATION_EVENT : null,
      provider_message_id: delivery.providerId ?? null,
      status: delivery.sent ? 'sent' : 'manual',
      outcome: 'invitation',
      payload: { invitationId: invitation.id, reason: delivery.reason ?? null } as any, created_by: staffId,
    });
    if (canTransition(lead.contact_state, 'INVITED') && lead.contact_state !== 'INVITED') await this.applyState(lead, 'INVITED');
    if (delivery.sent) { lead.last_contacted_at = new Date(); await this.leads.save(lead); }
    return {
      invitationId: invitation.id, expiresAt, channel: delivery.channel,
      delivery: delivery.sent ? 'sent' : 'manual',
      reason: delivery.reason ?? null,
      // the raw link is only handed back when staff must share it themselves
      ...(delivery.sent ? {} : { link }),
    };
  }

  private async deliverInvitation(lead: HostLeadEntity, want: 'auto' | 'email' | 'whatsapp' | 'manual', link: string, expiresAt: Date) {
    const manual = (reason: string) => ({ sent: false as const, channel: 'manual' as const, reason, providerId: undefined as string | undefined });
    if (want === 'manual') return manual('staff chose manual sharing');
    const order = want === 'auto' ? (['whatsapp', 'email'] as const) : ([want] as const);
    let lastReason = 'no channel available';
    for (const ch of order) {
      const gate = await this.canAutoSend(lead, ch);
      if (!gate.ok) { lastReason = `${ch}: ${gate.reason}`; continue; }
      if (ch === 'whatsapp') {
        const r = await this.whatsapp.sendTemplate({
          to: normalizePhone(lead.phone)!, template: 'host_invitation',
          params: { host_name: lead.contact_name || 'there', claim_url: link },
          relatedType: 'host_lead', relatedId: lead.id,
        });
        if (r.status === 'blocked') { lastReason = `whatsapp: ${r.reason}`; continue; }
        return { sent: true as const, channel: 'whatsapp' as const, providerId: r.waMessageId, reason: undefined as string | undefined };
      }
      try {
        await this.notifications.sendEmailNow(lead.email!, HOST_INVITATION_EVENT, {
          hostName: lead.contact_name, propertyName: lead.property_hint, claimUrl: link,
          expiresOn: expiresAt.toISOString().slice(0, 10),
        });
        return { sent: true as const, channel: 'email' as const, providerId: undefined as string | undefined, reason: undefined as string | undefined };
      } catch (e: any) {
        lastReason = `email: ${e?.message ?? 'send failed'}`;
      }
    }
    return manual(lastReason);
  }

  /** Resend = brand-new token (only the hash is stored, so the old one cannot be re-sent); the old link is revoked. */
  async resendInvitation(invitationId: string, dto: CreateInvitationDto, staffId: string) {
    const inv = await this.invites.findOne({ where: { id: invitationId } });
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.used_at) throw new ConflictException('Invitation already used');
    return this.createInvitation(inv.lead_id, dto, staffId, inv);
  }

  async revokeInvitation(invitationId: string) {
    const res = await this.invites.update({ id: invitationId, used_at: IsNull(), revoked_at: IsNull() }, { revoked_at: new Date() });
    if (!res.affected) throw new NotFoundException('Active invitation not found');
    return { revoked: true };
  }

  /** Public. Minimal info; a bad token and a missing one are indistinguishable. */
  async verifyInvitation(token: string) {
    const inv = await this.invites.findOne({ where: { token_hash: hashInviteToken(token) } });
    const state = invitationState(inv, new Date());
    if (!inv || state !== 'valid') return { valid: false, reason: state === 'missing' ? 'invalid' : state };
    const lead = await this.leads.findOne({ where: { id: inv.lead_id } });
    if (!lead || lead.contact_state === 'DO_NOT_CONTACT') return { valid: false, reason: 'revoked' };
    let propertyName: string | null = lead.property_hint;
    if (lead.listing_id) {
      const rows = await this.db.query(`SELECT title FROM listings WHERE id = $1`, [lead.listing_id]).catch(() => []);
      propertyName = rows[0]?.title ?? propertyName;
    }
    return { valid: true, propertyName, expiresAt: inv.expires_at };
  }

  /**
   * For the claims agent: atomically spend a token (single use, replay-proof) and return the lead/listing.
   * Returns null when the token is unknown, expired, revoked or already used.
   */
  async consumeInvitation(token: string, userId: string): Promise<{ leadId: string; listingId: string | null } | null> {
    const rows = await this.db.query(
      `UPDATE host_invitations SET used_at = now(), used_by_user_id = $2
         WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
         RETURNING lead_id`,
      [hashInviteToken(token), userId],
    );
    const flat = rowsOf(rows);
    if (!flat.length) return null;
    const lead = await this.mustGet(flat[0].lead_id);
    if (lead.contact_state !== 'ONBOARDING' && canTransition(lead.contact_state, 'ONBOARDING')) await this.applyState(lead, 'ONBOARDING');
    return { leadId: lead.id, listingId: lead.listing_id };
  }

  // ---------- conversion (called by the claims agent once a claim is APPROVED) ----------

  /** Accepts a lead id or a listing (candidate) id. Idempotent. Bypasses the manual matrix on purpose: an approved claim is authoritative. */
  async markConverted(leadOrListingId: string): Promise<HostLeadEntity | null> {
    const lead = (await this.leads.findOne({ where: { id: leadOrListingId } })) ?? (await this.leads.findOne({ where: { listing_id: leadOrListingId } }));
    if (!lead) return null;
    if (lead.contact_state === 'CONVERTED') return lead;
    await this.applyState(lead, 'CONVERTED');
    await this.invites.update({ lead_id: lead.id, used_at: IsNull(), revoked_at: IsNull() }, { revoked_at: new Date() });
    await this.tasks.update({ lead_id: lead.id, done_at: IsNull() }, { done_at: new Date(), note: 'closed: converted' });
    return lead;
  }

  // ---------- self-registration ----------

  async selfRegister(dto: HostRegistrationDto): Promise<{ ok: true }> {
    if (dto.website && dto.website.trim() !== '') return { ok: true }; // honeypot: pretend success, do nothing
    const phone = normalizePhone(dto.phone);
    if (!phone) throw new BadRequestException('Enter a valid phone number');
    const email = dto.email?.toLowerCase() ?? null;
    let lead = await this.leads.findOne({ where: email ? [{ phone }, { email }] : [{ phone }] });
    if (lead?.contact_state === 'DO_NOT_CONTACT') return { ok: true }; // never silently re-open an opt-out
    if (!lead) {
      lead = await this.leads.save(this.leads.create({
        phone, email, contact_name: dto.name, property_hint: dto.propertyName ?? null,
        source: 'host_self_registered', contact_state: 'NOT_CONTACTED', notes: dto.message ?? null,
        next_action_at: new Date(),
      }));
    } else {
      lead.contact_name ||= dto.name; lead.email ||= email; lead.property_hint ||= dto.propertyName ?? null;
      if (dto.message) lead.notes = [lead.notes, dto.message].filter(Boolean).join('\n');
    }
    // Explicit, recorded consent captured at the moment of registration.
    const src = 'self_registration';
    await this.consent.set('host_lead', lead.id, 'whatsapp', 'granted', src);
    await this.consent.set('phone', phone, 'whatsapp', 'granted', src);
    if (email) await this.consent.set('host_lead', lead.id, 'email', 'granted', src);
    if (canTransition(lead.contact_state, 'INTERESTED') && lead.contact_state !== 'INTERESTED') await this.applyState(lead, 'INTERESTED');
    else await this.leads.save(lead);
    await this.attempts.insert({
      lead_id: lead.id, channel: 'self_registration', direction: 'inbound', status: 'received', outcome: 'interested',
      payload: { consentToContact: true },
    });
    return { ok: true };
  }

  // ---------- analytics ----------

  async analytics(q: AnalyticsQueryDto) {
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 90 * DAY);
    const to = q.to ? new Date(q.to) : new Date();
    const win = `l.created_at >= $1 AND l.created_at < $2`;
    const byState: { contact_state: string; n: string }[] = await this.db.query(
      `SELECT contact_state, count(*)::text n FROM host_leads l WHERE ${win} GROUP BY contact_state`, [from, to]);
    const [f] = await this.db.query(
      `SELECT count(*)::int total, count(first_contacted_at)::int contacted, count(interested_at)::int interested,
              count(invited_at)::int invited, count(converted_at)::int converted
         FROM host_leads l WHERE ${win}`, [from, to]);
    const staff = await this.db.query(
      `SELECT owner_staff_id, count(*)::int total, count(first_contacted_at)::int contacted, count(interested_at)::int interested,
              count(invited_at)::int invited, count(converted_at)::int converted
         FROM host_leads l WHERE ${win} GROUP BY owner_staff_id ORDER BY total DESC`, [from, to]);
    const [t] = await this.db.query(
      `SELECT count(*)::int n,
              avg(extract(epoch FROM (first_contacted_at - created_at)))::float avg_s,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (first_contacted_at - created_at)))::float median_s
         FROM host_leads l WHERE ${win} AND first_contacted_at IS NOT NULL`, [from, to]);
    return {
      window: { from, to },
      countsByState: Object.fromEntries(byState.map((r) => [r.contact_state, Number(r.n)])),
      funnel: { counts: f, rates: computeFunnel(f) },
      perStaff: staff.map((s: any) => ({
        staffId: s.owner_staff_id, counts: s,
        rates: { contactRate: computeFunnel(s).contactRate, overallConversion: computeFunnel(s).overallConversion },
      })),
      timeToFirstContact: { leadsMeasured: t?.n ?? 0, avgSeconds: t?.avg_s ?? null, medianSeconds: t?.median_s ?? null },
    };
  }
}

export function invitationState(inv: Pick<HostInvitationEntity, 'used_at' | 'revoked_at' | 'expires_at'> | null | undefined, now: Date): 'valid' | 'missing' | 'used' | 'revoked' | 'expired' {
  if (!inv) return 'missing';
  if (inv.used_at) return 'used';
  if (inv.revoked_at) return 'revoked';
  if (inv.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'valid';
}

/** 23:59:59.999 IST of the day containing `now`. */
export function endOfDayIST(now: Date): Date {
  const IST = 5.5 * 3600_000;
  const local = new Date(now.getTime() + IST);
  local.setUTCHours(23, 59, 59, 999);
  return new Date(local.getTime() - IST);
}
