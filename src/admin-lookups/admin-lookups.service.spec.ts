import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminLookupsService } from './admin-lookups.service';
import { ConsentQueryDto, UserLookupDto } from './admin-lookups.dto';
import { AdminLookupsController } from './admin-lookups.controller';
import { AdminGuard } from '../auth/admin.guard';

const U = '11111111-1111-4111-8111-111111111111';

describe('AdminLookupsService', () => {
  it('staff queries unbanned admins only and returns full email', async () => {
    const ds: any = { query: jest.fn().mockResolvedValue([{ id: U, name: 'Asha', email: 'asha@x.in' }]) };
    const svc = new AdminLookupsService(ds, {} as any);
    expect(await svc.staff()).toEqual({ data: [{ id: U, name: 'Asha', email: 'asha@x.in' }] });
    expect(ds.query.mock.calls[0][0]).toMatch(/role = 'admin' and banned_at is null/);
  });
  it('consent maps rows via ConsentService.list', async () => {
    const consent: any = { list: jest.fn().mockResolvedValue([{ channel: 'whatsapp', consent_status: 'granted', source: 's', consented_at: null, revoked_at: null }]) };
    const r = await new AdminLookupsService({} as any, consent).consentFor('lead', 'L1', 'whatsapp');
    expect(consent.list).toHaveBeenCalledWith('lead', 'L1', 'whatsapp');
    expect(r.data[0]).toMatchObject({ channel: 'whatsapp', status: 'granted' });
  });
  it('users dedupes and returns [] for empty', async () => {
    const ds: any = { query: jest.fn().mockResolvedValue([{ id: U, name: 'A' }]) };
    const svc = new AdminLookupsService(ds, {} as any);
    await svc.users([U, U]);
    expect(ds.query.mock.calls[0][1]).toEqual([[U]]);
    expect(await svc.users([])).toEqual([]);
  });
});

describe('DTOs and guard', () => {
  it('rejects more than 50 ids and bad uuids', async () => {
    const many = plainToInstance(UserLookupDto, { ids: Array(51).fill(U).join(',') });
    expect((await validate(many)).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(UserLookupDto, { ids: 'nope' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(UserLookupDto, { ids: `${U},${U}` }))).length).toBe(0);
  });
  it('validates consent subjectType', async () => {
    expect((await validate(plainToInstance(ConsentQueryDto, { subjectType: 'x', subjectId: '1' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ConsentQueryDto, { subjectType: 'lead', subjectId: '1' }))).length).toBe(0);
  });
  it('controller is behind AdminGuard', () => {
    expect(Reflect.getMetadata('__guards__', AdminLookupsController)).toContain(AdminGuard);
  });
});
