import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CrmService, endOfDayIST, invitationState } from './crm.service';
import { claimUrl, generateInviteToken, hashInviteToken, INVITE_TOKEN_RE } from './crm.tokens';
import { CONTACT_STATES, CONTACT_TRANSITIONS, canTransition, computeFunnel, rate } from './crm.types';
import { normalizePhone } from './crm.phone';
import { applyOptOutByPhone, rowsOf, syncDiscoveryState } from './crm-sql';
import { WhatsappConsentChecker } from './whatsapp-consent.checker';

const lead = (o: any = {}) => ({
  id: 'L1', listing_id: 'LST', contact_state: 'NOT_CONTACTED', phone: '+919876543210', email: 'h@x.in',
  contact_name: 'Asha', property_hint: 'Cabin', owner_staff_id: null, first_contacted_at: null, ...o,
});

function make(l: any = lead(), consentAllowed = true) {
  const leads: any = { findOne: jest.fn().mockResolvedValue(l), save: jest.fn(async (x) => ({ id: 'L1', ...x })), create: jest.fn((x) => x), update: jest.fn() };
  const attempts: any = { insert: jest.fn(), save: jest.fn(async (x) => x), create: jest.fn((x) => x) };
  const invites: any = { findOne: jest.fn(), save: jest.fn(async (x) => ({ id: 'I1', ...x })), create: jest.fn((x) => x), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const tasks: any = { update: jest.fn() };
  const db: any = { query: jest.fn().mockResolvedValue([]) };
  const consent: any = { isAllowed: jest.fn().mockResolvedValue(consentAllowed), set: jest.fn() };
  const whatsapp: any = { sendTemplate: jest.fn().mockResolvedValue({ status: 'queued', waMessageId: 'w1', dryRun: true }) };
  const notifications: any = { sendEmailNow: jest.fn().mockResolvedValue(undefined) };
  const config: any = { get: () => 'https://app.test' };
  const svc = new CrmService(leads, attempts, invites, tasks, db, consent, whatsapp, notifications, config);
  return { svc, leads, attempts, invites, tasks, db, consent, whatsapp, notifications };
}

describe('consent / DO_NOT_CONTACT gate', () => {
  it('blocks automated send without recorded consent and returns the manual link', async () => {
    const m = make(lead(), false);
    const r: any = await m.svc.createInvitation('L1', { channel: 'auto' }, 'staff');
    expect(r.delivery).toBe('manual');
    expect(r.link).toMatch(/^https:\/\/app\.test\/claim\?token=[A-Za-z0-9_-]{43}$/);
    expect(m.whatsapp.sendTemplate).not.toHaveBeenCalled();
    expect(m.notifications.sendEmailNow).not.toHaveBeenCalled();
  });
  it('sends via whatsapp first when consent exists and omits the raw link', async () => {
    const m = make();
    const r: any = await m.svc.createInvitation('L1', {}, 'staff');
    expect(r).toMatchObject({ delivery: 'sent', channel: 'whatsapp' });
    expect(r.link).toBeUndefined();
    expect(m.whatsapp.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ template: 'host_invitation', relatedType: 'host_lead' }));
  });
  it('falls back to email when whatsapp is blocked downstream', async () => {
    const m = make();
    m.whatsapp.sendTemplate.mockResolvedValue({ status: 'blocked', reason: 'blocked: no consent' });
    const r: any = await m.svc.createInvitation('L1', {}, 'staff');
    expect(r.channel).toBe('email');
    expect(m.notifications.sendEmailNow).toHaveBeenCalled();
  });
  it('DO_NOT_CONTACT refuses invitations, outbound logging, and canAutoSend, even with consent', async () => {
    const m = make(lead({ contact_state: 'DO_NOT_CONTACT' }), true);
    await expect(m.svc.createInvitation('L1', {}, 's')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(m.svc.logAttempt('L1', { channel: 'call', outcome: 'no_answer' }, 's')).rejects.toBeInstanceOf(ForbiddenException);
    expect(await m.svc.canAutoSend(lead({ contact_state: 'DO_NOT_CONTACT' }) as any, 'email')).toMatchObject({ ok: false });
    expect(m.whatsapp.sendTemplate).not.toHaveBeenCalled();
  });
  it('public-source contact details alone do not authorise sending', async () => {
    const m = make(lead({ source: 'google_public' }), false);
    expect((await m.svc.canAutoSend(lead() as any, 'whatsapp')).ok).toBe(false);
    expect(m.consent.isAllowed).toHaveBeenCalledWith('host_lead', 'L1', 'whatsapp');
  });
  it('whatsapp checker denies a DNC phone even when a grant row exists, and denies without grant', async () => {
    const consent: any = { isAllowed: jest.fn().mockResolvedValue(true), set: jest.fn() };
    const db: any = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    expect(await new WhatsappConsentChecker(consent, db).hasGrantedConsent('+919876543210')).toBe(false);
    db.query.mockResolvedValue([]);
    expect(await new WhatsappConsentChecker(consent, db).hasGrantedConsent('+919876543210')).toBe(true);
    consent.isAllowed.mockResolvedValue(false);
    expect(await new WhatsappConsentChecker(consent, db).hasGrantedConsent('+919876543210')).toBe(false);
  });
  it('STOP revokes consent and runs the opt-out SQL', async () => {
    const consent: any = { isAllowed: jest.fn(), set: jest.fn() };
    const db: any = { query: jest.fn().mockResolvedValue([]) };
    await new WhatsappConsentChecker(consent, db).recordRevocation('+919876543210', 'whatsapp_inbound_stop');
    expect(consent.set).toHaveBeenCalledWith('phone', '+919876543210', 'whatsapp', 'revoked', 'whatsapp_inbound_stop');
    expect(db.query.mock.calls[0][0]).toMatch(/DO_NOT_CONTACT/);
  });
  it('applyOptOutByPhone handles [rows, count] shape and cascades per lead', async () => {
    const db: any = { query: jest.fn().mockResolvedValueOnce([[{ id: 'L1', listing_id: 'X' }], 1]).mockResolvedValue([]) };
    expect(await applyOptOutByPhone(db, '+919876543210', 'stop')).toBe(1);
    expect(db.query.mock.calls.length).toBeGreaterThan(4);
  });
  it('self-registration records consent; honeypot does nothing; DNC is not reopened', async () => {
    const m = make(null as any);
    m.leads.findOne.mockResolvedValue(null);
    const dto: any = { name: 'Asha', phone: '9876543210', email: 'A@x.in', consentToContact: true };
    await m.svc.selfRegister({ ...dto, website: 'http://spam' });
    expect(m.leads.save).not.toHaveBeenCalled();
    await m.svc.selfRegister(dto);
    expect(m.consent.set).toHaveBeenCalledWith('host_lead', expect.anything(), 'whatsapp', 'granted', 'self_registration');
    expect(m.consent.set).toHaveBeenCalledWith('host_lead', expect.anything(), 'email', 'granted', 'self_registration');
    const m2 = make(lead({ contact_state: 'DO_NOT_CONTACT' }));
    await m2.svc.selfRegister(dto);
    expect(m2.consent.set).not.toHaveBeenCalled();
  });
  it('opt-out by token returns the same body for unknown tokens', async () => {
    const m = make();
    m.invites.findOne.mockResolvedValue(null);
    expect(await m.svc.optOutByToken(generateInviteToken())).toEqual({ ok: true });
    m.invites.findOne.mockResolvedValue({ lead_id: 'L1' });
    expect(await m.svc.optOutByToken(generateInviteToken())).toEqual({ ok: true });
    expect(m.consent.set).toHaveBeenCalledWith('host_lead', 'L1', 'email', 'revoked', 'opt_out');
  });
});

describe('invitation tokens', () => {
  it('generates 32 random bytes, url-safe, and stores only a sha256', async () => {
    const t = generateInviteToken();
    expect(t).toMatch(INVITE_TOKEN_RE);
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(generateInviteToken()).not.toBe(t);
    expect(hashInviteToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(t)).not.toContain(t);
    expect(claimUrl('https://a.b/', t)).toBe(`https://a.b/claim?token=${t}`);
    const m = make();
    await m.svc.createInvitation('L1', { channel: 'manual' }, 's');
    const saved = m.invites.save.mock.calls[0][0];
    expect(JSON.stringify(saved)).not.toMatch(/token":/);
    expect(saved.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.invites.update).toHaveBeenCalled(); // older live invitations revoked
  });
  it('expiry / used / revoked / missing states', () => {
    const now = new Date('2026-11-22T00:00:00Z');
    const base = { used_at: null, revoked_at: null, expires_at: new Date('2026-11-23T00:00:00Z') };
    expect(invitationState(base, now)).toBe('valid');
    expect(invitationState({ ...base, expires_at: new Date('2026-11-21T00:00:00Z') }, now)).toBe('expired');
    expect(invitationState({ ...base, used_at: now }, now)).toBe('used');
    expect(invitationState({ ...base, revoked_at: now }, now)).toBe('revoked');
    expect(invitationState(null, now)).toBe('missing');
  });
  it('verify returns minimal info or a generic invalid', async () => {
    const m = make();
    m.invites.findOne.mockResolvedValue(null);
    expect(await m.svc.verifyInvitation('x')).toEqual({ valid: false, reason: 'invalid' });
    m.invites.findOne.mockResolvedValue({ lead_id: 'L1', used_at: null, revoked_at: null, expires_at: new Date(Date.now() + 1e6) });
    m.db.query.mockResolvedValue([{ title: 'Pine Cabin' }]);
    const r: any = await m.svc.verifyInvitation('x');
    expect(Object.keys(r).sort()).toEqual(['expiresAt', 'propertyName', 'valid']);
  });
  it('replay: consume succeeds once, then returns null (atomic UPDATE guard)', async () => {
    const m = make(lead({ contact_state: 'INVITED' }));
    m.db.query.mockResolvedValueOnce([[{ lead_id: 'L1' }], 1]).mockResolvedValue([]);
    expect(await m.svc.consumeInvitation('t', 'U1')).toEqual({ leadId: 'L1', listingId: 'LST' });
    expect(m.db.query.mock.calls[0][0]).toMatch(/used_at IS NULL AND revoked_at IS NULL AND expires_at > now\(\)/);
    m.db.query.mockResolvedValueOnce([[], 0]);
    expect(await m.svc.consumeInvitation('t', 'U2')).toBeNull();
  });
  it('resend issues a fresh token and increments resend_count', async () => {
    const m = make();
    m.invites.findOne.mockResolvedValue({ id: 'I0', lead_id: 'L1', used_at: null, resend_count: 2 });
    await m.svc.resendInvitation('I0', { channel: 'manual' }, 's');
    expect(m.invites.save.mock.calls[0][0].resend_count).toBe(3);
  });
});

describe('state matrix', () => {
  it('every state has an entry; DO_NOT_CONTACT is terminal; CONVERTED only -> DNC', () => {
    expect(Object.keys(CONTACT_TRANSITIONS).sort()).toEqual([...CONTACT_STATES].sort());
    expect(CONTACT_TRANSITIONS.DO_NOT_CONTACT).toEqual([]);
    expect(CONTACT_TRANSITIONS.CONVERTED).toEqual(['DO_NOT_CONTACT']);
  });
  it('CONVERTED is reachable only from ONBOARDING in the manual matrix, and PATCH refuses it', async () => {
    const from = CONTACT_STATES.filter((s) => canTransition(s, 'CONVERTED') && s !== 'CONVERTED');
    expect(from).toEqual(['ONBOARDING']);
    const m = make(lead({ contact_state: 'ONBOARDING' }));
    await expect(m.svc.updateLead('L1', { contactState: 'CONVERTED' }, 's')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('illegal jump is rejected', async () => {
    const m = make(lead({ contact_state: 'NOT_CONTACTED' }));
    await expect(m.svc.updateLead('L1', { contactState: 'ONBOARDING' }, 's')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('logging a call advances contact_state and discovery_state, never regresses', async () => {
    const m = make();
    const r = await m.svc.logAttempt('L1', { channel: 'call', outcome: 'no_answer' }, 's');
    expect(r.advancedTo).toBe('CONTACT_ATTEMPTED');
    const sql = m.db.query.mock.calls.find((c: any[]) => /UPDATE listings/.test(c[0]));
    expect(sql[1].slice(0, 2)).toEqual(['CONTACT_IN_PROGRESS', 'LST']);
    expect(sql[0]).toMatch(/discovery_state = ANY/);
    const m2 = make(lead({ contact_state: 'INTERESTED' }));
    expect((await m2.svc.logAttempt('L1', { channel: 'call', outcome: 'no_answer' }, 's')).advancedTo).toBeNull();
  });
  it('do_not_contact outcome revokes consent and closes tasks', async () => {
    const m = make(lead({ contact_state: 'CONTACTED' }));
    await m.svc.logAttempt('L1', { channel: 'call', outcome: 'do_not_contact' }, 's');
    expect(m.consent.set).toHaveBeenCalledWith('host_lead', 'L1', 'whatsapp', 'revoked', 'opt_out');
    expect(m.tasks.update).toHaveBeenCalled();
  });
  it('markConverted is idempotent, accepts a listing id, and ignores unknown ids', async () => {
    const m = make();
    m.leads.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(lead({ contact_state: 'INTERESTED' }));
    const r = await m.svc.markConverted('LST');
    expect(r!.contact_state).toBe('CONVERTED');
    const m2 = make(lead({ contact_state: 'CONVERTED' }));
    await m2.svc.markConverted('L1');
    expect(m2.leads.save).not.toHaveBeenCalled();
    const m3 = make(null as any); m3.leads.findOne.mockResolvedValue(null);
    expect(await m3.svc.markConverted('zzz')).toBeNull();
  });
  it('syncDiscoveryState skips unmapped states and swallows a missing column', async () => {
    const db: any = { query: jest.fn().mockRejectedValue(new Error('column "discovery_state" does not exist')) };
    expect(await syncDiscoveryState(db, 'X', 'NOT_CONTACTED')).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(await syncDiscoveryState(db, 'X', 'DECLINED')).toBe(false);
  });
});

describe('analytics maths', () => {
  it('rates carry numerator/denominator and null on zero denominator', () => {
    expect(rate(1, 3)).toEqual({ numerator: 1, denominator: 3, rate: 0.3333 });
    expect(rate(0, 0).rate).toBeNull();
    const f = computeFunnel({ total: 100, contacted: 50, interested: 20, invited: 10, converted: 4 });
    expect(f.contactRate.rate).toBe(0.5);
    expect(f.interestRate.rate).toBe(0.4);
    expect(f.inviteRate.rate).toBe(0.5);
    expect(f.conversionOfInvited.rate).toBe(0.4);
    expect(f.overallConversion.rate).toBe(0.04);
    expect(computeFunnel({ total: 0, contacted: 0, interested: 0, invited: 0, converted: 0 }).overallConversion.rate).toBeNull();
  });
  it('analytics assembles counts, funnel and time-to-first-contact', async () => {
    const m = make();
    m.db.query
      .mockResolvedValueOnce([{ contact_state: 'CONTACTED', n: '3' }])
      .mockResolvedValueOnce([{ total: 10, contacted: 5, interested: 2, invited: 1, converted: 1 }])
      .mockResolvedValueOnce([{ owner_staff_id: 'S1', total: 10, contacted: 5, interested: 2, invited: 1, converted: 1 }])
      .mockResolvedValueOnce([{ n: 5, avg_s: 3600, median_s: 1800 }]);
    const r = await m.svc.analytics({});
    expect(r.countsByState).toEqual({ CONTACTED: 3 });
    expect(r.funnel.rates.overallConversion.rate).toBe(0.1);
    expect(r.perStaff[0].rates.contactRate.rate).toBe(0.5);
    expect(r.timeToFirstContact).toEqual({ leadsMeasured: 5, avgSeconds: 3600, medianSeconds: 1800 });
  });
});

describe('misc', () => {
  it('normalizePhone', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('123')).toBeNull();
  });
  it('endOfDayIST', () => {
    expect(endOfDayIST(new Date('2026-11-22T03:00:00Z')).toISOString()).toBe('2026-11-22T18:29:59.999Z');
  });
  it('sweep returns number of created tasks (handles row shape)', async () => {
    const m = make();
    m.db.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    expect(await m.svc.sweepFollowUps()).toBe(2);
    expect(m.db.query.mock.calls[0][0]).toMatch(/NOT EXISTS \(SELECT 1 FROM follow_up_tasks/);
  });
  it('rowsOf', () => { expect(rowsOf([[{ a: 1 }], 1])).toEqual([{ a: 1 }]); expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]); });
});

describe('enriched admin responses', () => {
  it('my-tasks include the joined lead name/phone/state', async () => {
    const m = make();
    const qb: any = { innerJoin: () => qb, addSelect: () => qb, where: () => qb, andWhere: () => qb, orderBy: () => qb, limit: () => qb,
      getMany: async () => [{ id: 't1', lead_id: 'L1', due_at: new Date('2020-01-01') }] };
    (m.svc as any).tasks.createQueryBuilder = () => qb;
    m.leads.find = jest.fn().mockResolvedValue([lead()]);
    const [t] = await m.svc.myTasks('staff', 'all');
    expect(t.lead).toEqual({ id: 'L1', name: 'Asha', phone: '+919876543210', state: 'NOT_CONTACTED', propertyHint: 'Cabin' });
    expect(t.overdue).toBe(true);
  });
  it('lead list includes owner name and listing destination/state', async () => {
    const m = make();
    const qb: any = { andWhere: () => qb, orderBy: () => qb, skip: () => qb, take: () => qb,
      getManyAndCount: async () => [[lead({ owner_staff_id: 'S1', listing_id: 'LST' })], 1] };
    m.leads.createQueryBuilder = () => qb;
    m.db.query.mockImplementation(async (sql: string) =>
      /FROM users/.test(sql) ? [{ id: 'S1', full_name: 'Ravi' }] : [{ id: 'LST', discovery_destination: 'Kasol', discovery_state: 'unclaimed' }]);
    const r = await m.svc.listLeads({} as any);
    expect(r.items[0].owner).toEqual({ id: 'S1', name: 'Ravi' });
    expect(r.items[0].listing).toEqual({ id: 'LST', destination: 'Kasol', discovery_state: 'unclaimed' });
  });
});
