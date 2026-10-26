import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthGuard } from '../src/auth/auth.guard';
import { StorageService } from '../src/storage/storage.service';
import { VerificationController } from '../src/verification/verification.controller';
import { VerificationService } from '../src/verification/verification.service';
import { UserEntity, VerificationAuditLogEntity, VerificationRequestEntity } from '../src/entities';

function makeStore() {
  const rows: Record<string, any>[] = [];
  const requests = {
    findOne: async ({ where }: any) =>
      rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).sort((a, b) => b.submitted_at - a.submitted_at)[0] ??
      null,
    save: async (r: any) => (rows.push(r), r),
  };
  const profiles = { findOne: async () => ({ id: 'u1', full_name: 'Asha Rao' }), update: async () => undefined };
  const auditLog = { create: (x: any) => x, save: async () => undefined };
  return { rows, requests, profiles, auditLog };
}

describe('Verification API (HTTP, real controller + service, fake DB/storage)', () => {
  let app: INestApplication;
  let store: ReturnType<typeof makeStore>;

  beforeEach(async () => {
    store = makeStore();

    const moduleRef = await Test.createTestingModule({
      controllers: [VerificationController],
      providers: [
        VerificationService,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: StorageService, useValue: {} },
        { provide: getRepositoryToken(VerificationRequestEntity), useValue: store.requests },
        { provide: getRepositoryToken(VerificationAuditLogEntity), useValue: store.auditLog },
        { provide: getRepositoryToken(UserEntity), useValue: store.profiles },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: (ctx: any) => ((ctx.switchToHttp().getRequest().user = { userId: 'u1' }), true) })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    '/api/verification/identity',
    '/api/verification/identity/resubmit',
    '/api/verification/selfie',
    '/api/verification/selfie/resubmit',
    '/api/verification/selfie/verify',
    '/api/verification/pan',
    '/api/verification/pan/resubmit',
    '/api/verification/pan/verify',
    '/api/verification/bank',
    '/api/verification/bank/resubmit',
    '/api/verification/bank/change',
    '/api/verification/bank/verify',
    '/api/verification/upi/verify',
  ])('POST %s does not exist', async (path) => {
    await request(app.getHttpServer()).post(path).expect(404);
    expect(store.rows).toHaveLength(0);
  });

  it('GET /status reports only identity and selfie', async () => {
    const res = await request(app.getHttpServer()).get('/api/verification/status').expect(200);
    expect(res.body.identity.status).toBe('not_started');
    expect(res.body.selfie.status).toBe('not_started');
    for (const gone of ['pan', 'bank', 'upiId', 'kycProvider']) expect(res.body).not.toHaveProperty(gone);
  });
});
