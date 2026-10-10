import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';
import { AuthGuard, SESSION_COOKIE } from '../src/auth/auth.guard';
import { SupabaseProvider } from '../src/auth/supabase.provider';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationsService } from '../src/conversations/conversations.service';
import { ReviewsController } from '../src/reviews/reviews.controller';
import { ReviewsService } from '../src/reviews/reviews.service';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { NotificationsService } from '../src/notifications/notifications.service';
import { StorageController } from '../src/storage/storage.controller';
import { StorageService } from '../src/storage/storage.service';
import {
  BookingEntity,
  CallEntity,
  ConversationEntity,
  ConversationPresenceEntity,
  ListingEntity,
  MessageEntity,
  NotificationLogEntity,
  ReviewEntity,
  UserEntity,
} from '../src/entities';

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const SECRET = 'test-secret';
const GUEST = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const LISTING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MISSING_UUID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const tokenFor = (sub: string, opts: jwt.SignOptions = {}) => jwt.sign({ sub }, SECRET, opts);
const cookie = (sub: string) => `${SESSION_COOKIE}=${tokenFor(sub)}`;

/* ── Tiny in-memory repository ─────────────────────────────────────────────── */

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function matches(row: any, where: any): boolean {
  if (Array.isArray(where)) return where.some((w) => matches(row, w));
  return Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
}

function makeRepo<T extends Record<string, any>>(rows: T[] = []) {
  return {
    rows,
    findOne: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    find: async ({ where, order }: any = {}) => {
      const out = rows.filter((r) => matches(r, where));
      const [[key, dir]] = Object.entries(order ?? { _: 'ASC' }) as [string, string][];
      if (key !== '_') out.sort((a: any, b: any) => (dir === 'DESC' ? -1 : 1) * (new Date(a[key]).getTime() - new Date(b[key]).getTime()));
      return out;
    },
    create: (x: any) => ({ ...x }),
    save: async (x: any) => {
      x.id = x.id ?? uid();
      x.created_at = x.created_at ?? new Date();
      rows.push(x);
      return x;
    },
    insert: async (x: any) => {
      rows.push({ id: uid(), created_at: new Date(), ...x });
    },
    update: async (where: any, patch: any) => {
      rows.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, patch));
    },
    upsert: async (x: any, keys: string[]) => {
      const hit = rows.find((r) => keys.every((k) => r[k] === x[k]));
      if (hit) Object.assign(hit, x);
      else rows.push(x);
    },
    count: async ({ where }: any) => rows.filter((r) => Object.entries(where).every(([k, v]) => (k === 'read_at' ? r.read_at == null : r[k] === v))).length,
  };
}

/** Query-builder stand-in that honours the filters NotificationsService actually applies. */
function makeNotificationLog(rows: any[]) {
  const repo = makeRepo(rows);
  const builder = () => {
    const params: Record<string, any> = {};
    const b: any = {
      where: (_s: string, p?: any) => (Object.assign(params, p), b),
      andWhere: (_s: string, p?: any) => (Object.assign(params, p), b),
      orderBy: () => b,
      addOrderBy: () => b,
      limit: (n: number) => ((params.__limit = n), b),
      update: () => b,
      set: () => b,
      getMany: async () => {
        let out = rows.filter((r) => r.user_id === params.userId && r.channel === 'push');
        if (params.before) {
          const t = new Date(params.before).getTime();
          out = out.filter((r) => r.sent_at.getTime() < t || (r.sent_at.getTime() === t && r.id < params.beforeId));
        }
        out.sort((a, c) => c.sent_at.getTime() - a.sent_at.getTime() || (a.id < c.id ? 1 : -1));
        return out.slice(0, params.__limit);
      },
      execute: async () => {
        rows
          .filter((r) => r.user_id === params.userId && r.read_at == null && (params.id === undefined || r.id === params.id))
          .forEach((r) => (r.read_at = new Date()));
      },
    };
    return b;
  };
  return { ...repo, createQueryBuilder: builder };
}

/* ── App under test ────────────────────────────────────────────────────────── */

describe('Social endpoints: conversations, reviews, notifications, storage (HTTP, real controllers + services + AuthGuard, in-memory fakes)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  const notify = jest.fn();
  let uploadCalls: { bucket: string; path: string }[];
  let storageError: { message: string } | null;

  let conversations: ReturnType<typeof makeRepo>;
  let messages: ReturnType<typeof makeRepo>;
  let calls: ReturnType<typeof makeRepo>;
  let listings: ReturnType<typeof makeRepo>;
  let profiles: ReturnType<typeof makeRepo>;
  let presence: ReturnType<typeof makeRepo>;
  let bookings: ReturnType<typeof makeRepo>;
  let reviews: ReturnType<typeof makeRepo>;
  let notifLog: ReturnType<typeof makeNotificationLog>;

  beforeEach(async () => {
    notify.mockReset();
    uploadCalls = [];
    storageError = null;
    conversations = makeRepo();
    messages = makeRepo();
    calls = makeRepo();
    presence = makeRepo();
    listings = makeRepo([{ id: LISTING, host_id: HOST, draft_data: { property_details: { title: 'Sea View Flat' } } }]);
    profiles = makeRepo([
      { id: GUEST, full_name: 'Gita Guest', avatar_url: 'g.png' },
      { id: HOST, full_name: 'Hari Host', avatar_url: null },
    ]);
    bookings = makeRepo([
      { id: 'b-done', guest_id: GUEST, host_id: HOST, listing_id: LISTING, status: 'completed' },
      { id: 'b-out', guest_id: GUEST, host_id: HOST, listing_id: LISTING, status: 'checked_out' },
      { id: 'b-pending', guest_id: GUEST, host_id: HOST, listing_id: LISTING, status: 'pending' },
    ]);
    reviews = makeRepo();
    notifLog = makeNotificationLog([]);

    const moduleRef = await Test.createTestingModule({
      controllers: [ConversationsController, ReviewsController, NotificationsController, StorageController],
      providers: [
        ConversationsService,
        ReviewsService,
        NotificationsService,
        StorageService,
        AuthGuard,
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: (k: string) => ({ SUPABASE_JWT_SECRET: SECRET })[k] } },
        {
          provide: SupabaseProvider,
          useValue: {
            client: {
              storage: {
                from: (bucket: string) => ({
                  createSignedUploadUrl: async (path: string) => {
                    uploadCalls.push({ bucket, path });
                    return storageError ? { data: null, error: storageError } : { data: { signedUrl: `https://signed.test/${bucket}/${path}?t=1`, path }, error: null };
                  },
                }),
              },
            },
          },
        },
        { provide: getRepositoryToken(ConversationEntity), useValue: conversations },
        { provide: getRepositoryToken(MessageEntity), useValue: messages },
        { provide: getRepositoryToken(CallEntity), useValue: calls },
        { provide: getRepositoryToken(ListingEntity), useValue: listings },
        { provide: getRepositoryToken(UserEntity), useValue: profiles },
        { provide: getRepositoryToken(ConversationPresenceEntity), useValue: presence },
        { provide: getRepositoryToken(BookingEntity), useValue: bookings },
        { provide: getRepositoryToken(ReviewEntity), useValue: reviews },
        { provide: getRepositoryToken(NotificationLogEntity), useValue: notifLog },
      ],
    })
      .compile();

    // Swap just notify() on the real NotificationsService so message/call flows stay offline.
    jest.spyOn(moduleRef.get(NotificationsService), 'notify').mockImplementation(notify);

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = () => request(app.getHttpServer());
  });

  afterEach(async () => {
    await app.close();
  });

  const expectError = (res: request.Response, status: number, message?: RegExp | string) => {
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, statusCode: status });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.error).toBe(res.body.message);
    if (message) expect(res.body.message).toMatch(message instanceof RegExp ? message : new RegExp(message));
  };

  /** Every guarded route must refuse missing, garbage, wrongly-signed and expired sessions. */
  const guarded: [string, string, string, any?][] = [
    ['GET', '/api/conversations', 'list conversations', null],
    ['POST', '/api/conversations', 'create conversation', { listingId: LISTING }],
    ['POST', '/api/conversations/c1/messages', 'send message', { body: 'hi' }],
    ['POST', '/api/conversations/c1/presence', 'presence', null],
    ['POST', '/api/conversations/c1/calls', 'start call', { kind: 'voice' }],
    ['PATCH', '/api/conversations/c1/calls/k1', 'update call', { status: 'ended' }],
    ['POST', '/api/reviews/booking/b-done', 'create review', { rating: 5, content: 'ok' }],
    ['GET', '/api/notifications', 'list notifications', null],
    ['POST', '/api/notifications/mark-read', 'mark read', { all: true }],
    ['GET', '/api/notifications/unread-count', 'unread count', null],
    ['POST', '/api/storage/upload-url', 'upload url', { fileName: 'a.png' }],
  ];

  describe('authentication (all guarded endpoints)', () => {
    const send = (method: string, path: string, body: any, cookieHeader?: string) => {
      let r = (http() as any)[method.toLowerCase()](path);
      if (cookieHeader) r = r.set('Cookie', cookieHeader);
      return method === 'GET' ? r : r.send(body ?? {});
    };

    it.each(guarded)('%s %s (%s) answers 401 without a session cookie', async (method, path, _l, body) => {
      expectError(await send(method, path, body), 401, /No session cookie/);
    });

    it.each(guarded)('%s %s (%s) answers 401 for a garbage token', async (method, path, _l, body) => {
      expectError(await send(method, path, body, `${SESSION_COOKIE}=not-a-jwt`), 401, /Invalid or expired/);
    });

    it('rejects a token signed with the wrong secret', async () => {
      const bad = jwt.sign({ sub: GUEST }, 'other-secret');
      expectError(await http().get('/api/conversations').set('Cookie', `${SESSION_COOKIE}=${bad}`), 401);
    });

    it('rejects a validly signed token that has no subject', async () => {
      const bad = jwt.sign({ foo: 1 }, SECRET);
      expectError(await http().get('/api/conversations').set('Cookie', `${SESSION_COOKIE}=${bad}`), 401);
    });

    it('rejects an expired token', async () => {
      const expired = tokenFor(GUEST, { expiresIn: -10 });
      const res = await http().get('/api/notifications/unread-count').set('Cookie', `${SESSION_COOKIE}=${expired}`);
      expectError(res, 401, /expired/i);
    });

    it('accepts the cookie when it holds Supabase-style JSON with access_token', async () => {
      const value = encodeURIComponent(JSON.stringify({ access_token: tokenFor(GUEST) }));
      const res = await http().get('/api/notifications/unread-count').set('Cookie', `${SESSION_COOKIE}=${value}`);
      expect(res.status).toBe(200);
    });
  });

  /* ── Conversations ───────────────────────────────────────────────────── */

  describe('GET /api/conversations', () => {
    it('returns an empty list for a user with no conversations', async () => {
      const res = await http().get('/api/conversations').set('Cookie', cookie(GUEST)).expect(200);
      expect(res.body).toEqual([]);
    });

    it('lists the caller\'s conversations from each side, with listing title, other party and role', async () => {
      const t1 = new Date('2026-01-01T00:00:00Z');
      const t2 = new Date('2026-02-01T00:00:00Z');
      conversations.rows.push(
        { id: 'c-old', listing_id: LISTING, guest_id: GUEST, host_id: HOST, last_message_at: t1 },
        { id: 'c-new', listing_id: LISTING, guest_id: STRANGER, host_id: GUEST, last_message_at: t2 },
        { id: 'c-other', listing_id: LISTING, guest_id: STRANGER, host_id: HOST, last_message_at: t2 },
      );
      const asGuest = await http().get('/api/conversations').set('Cookie', cookie(GUEST)).expect(200);
      expect(asGuest.body.map((c: any) => c.id)).toEqual(['c-new', 'c-old']); // newest first, c-other hidden
      expect(asGuest.body[1]).toMatchObject({ listingId: LISTING, listingTitle: 'Sea View Flat', otherPartyName: 'Hari Host', role: 'guest' });
      expect(asGuest.body[0]).toMatchObject({ role: 'host', otherPartyName: 'Basera user' }); // unknown profile falls back

      const asHost = await http().get('/api/conversations').set('Cookie', cookie(HOST)).expect(200);
      expect(asHost.body.map((c: any) => c.id).sort()).toEqual(['c-old', 'c-other']);
      expect(asHost.body.find((c: any) => c.id === 'c-old')).toMatchObject({ role: 'host', otherPartyName: 'Gita Guest' });
    });
  });

  describe('POST /api/conversations', () => {
    const post = (body: any, who = GUEST) => http().post('/api/conversations').set('Cookie', cookie(who)).send(body);

    it('creates a conversation as guest with the listing\'s host and the response envelope', async () => {
      const res = await post({ listingId: LISTING }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Conversation ready.', listing_id: LISTING, guest_id: GUEST, host_id: HOST });
      expect(res.body.id).toBeDefined();
      expect(conversations.rows).toHaveLength(1);
    });

    it('is idempotent: the same guest and listing returns the same conversation', async () => {
      const a = await post({ listingId: LISTING }).expect(201);
      const b = await post({ listingId: LISTING }).expect(201);
      expect(b.body.id).toBe(a.body.id);
      expect(conversations.rows).toHaveLength(1);
    });

    it('gives a different guest their own conversation', async () => {
      const a = await post({ listingId: LISTING }).expect(201);
      const b = await post({ listingId: LISTING }, STRANGER).expect(201);
      expect(b.body.id).not.toBe(a.body.id);
    });

    it('400 when messaging yourself about your own listing', async () => {
      expectError(await post({ listingId: LISTING }, HOST), 400, /yourself/);
      expect(conversations.rows).toHaveLength(0);
    });

    it('404 for an unknown listing', async () => {
      expectError(await post({ listingId: MISSING_UUID }), 404, /Listing not found/);
    });

    it.each([
      ['missing listingId', {}],
      ['non-UUID listingId', { listingId: 'abc' }],
      ['numeric listingId', { listingId: 5 }],
    ])('400 for %s (DTO validation)', async (_l, body) => {
      const res = await post(body);
      expectError(res, 400, /listingId must be a UUID/);
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/UUID/)]));
    });
  });

  describe('POST /api/conversations/:id/messages', () => {
    let convId: string;
    beforeEach(() => {
      convId = 'c1';
      conversations.rows.push({ id: convId, listing_id: LISTING, guest_id: GUEST, host_id: HOST, last_message_at: null });
    });
    const send = (body: any, who = GUEST, id = convId) => http().post(`/api/conversations/${id}/messages`).set('Cookie', cookie(who)).send(body);

    it('stores the message, bumps last_message_at and notifies the other party', async () => {
      const res = await send({ body: 'Is it available?' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Message sent.' });
      expect(res.body.id).toBeDefined();
      expect(messages.rows[0]).toMatchObject({ conversation_id: convId, sender_id: GUEST, body: 'Is it available?' });
      expect(conversations.rows[0].last_message_at).toBeInstanceOf(Date);
      expect(notify).toHaveBeenCalledWith('message.received', HOST, expect.objectContaining({ senderName: 'Gita Guest', link: `/messages/${convId}` }));
    });

    it('the host can reply, and the guest is the one notified', async () => {
      await send({ body: 'Yes' }, HOST).expect(201);
      expect(notify).toHaveBeenCalledWith('message.received', GUEST, expect.any(Object));
    });

    it('skips the notification when the recipient heartbeated within 30s', async () => {
      presence.rows.push({ user_id: HOST, conversation_id: convId, last_seen_at: new Date() });
      await send({ body: 'hi' }).expect(201);
      expect(notify).not.toHaveBeenCalled();
    });

    it('still notifies when the recipient\'s heartbeat is stale', async () => {
      presence.rows.push({ user_id: HOST, conversation_id: convId, last_seen_at: new Date(Date.now() - 60_000) });
      await send({ body: 'hi' }).expect(201);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('403 for a non-participant, and nothing is stored', async () => {
      expectError(await send({ body: 'hi' }, STRANGER), 403, /Not a participant/);
      expect(messages.rows).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it('404 for an unknown conversation', async () => {
      expectError(await send({ body: 'hi' }, GUEST, 'nope'), 404, /Conversation not found/);
    });

    it.each([
      ['missing body', {}, /body must be a string/],
      ['empty body', { body: '' }, /body must be longer than or equal to 1/],
      ['non-string body', { body: 123 }, /body must be a string/],
      ['body over 4000 chars', { body: 'x'.repeat(4001) }, /shorter than or equal to 4000/],
    ])('400 for %s (DTO validation)', async (_l, body, msg) => {
      expectError(await send(body), 400, msg);
      expect(messages.rows).toHaveLength(0);
    });

    it('accepts a body of exactly 4000 chars', async () => {
      await send({ body: 'x'.repeat(4000) }).expect(201);
    });

    it('ignores an attempt to spoof sender_id (whitelist strips unknown fields)', async () => {
      await send({ body: 'hi', sender_id: HOST }).expect(201);
      expect(messages.rows[0].sender_id).toBe(GUEST);
    });
  });

  describe('POST /api/conversations/:id/presence', () => {
    beforeEach(() => {
      conversations.rows.push({ id: 'c1', listing_id: LISTING, guest_id: GUEST, host_id: HOST });
    });
    const beat = (who: string, id = 'c1') => http().post(`/api/conversations/${id}/presence`).set('Cookie', cookie(who));

    it('records a heartbeat and answers the standard envelope', async () => {
      const res = await beat(GUEST).expect(201);
      expect(res.body).toEqual({ success: true, message: 'Presence updated.' });
      expect(presence.rows).toHaveLength(1);
      expect(presence.rows[0]).toMatchObject({ user_id: GUEST, conversation_id: 'c1' });
    });

    it('coalesces repeated heartbeats onto one row', async () => {
      await beat(GUEST).expect(201);
      await beat(GUEST).expect(201);
      expect(presence.rows).toHaveLength(1);
    });

    it('403 for a non-participant', async () => {
      expectError(await beat(STRANGER), 403);
      expect(presence.rows).toHaveLength(0);
    });

    it('404 for an unknown conversation', async () => {
      expectError(await beat(GUEST, 'nope'), 404, /Conversation not found/);
    });
  });

  describe('calls', () => {
    beforeEach(() => {
      conversations.rows.push({ id: 'c1', listing_id: LISTING, guest_id: GUEST, host_id: HOST });
      conversations.rows.push({ id: 'c2', listing_id: LISTING, guest_id: STRANGER, host_id: HOST });
    });
    const start = (body: any, who = GUEST, id = 'c1') => http().post(`/api/conversations/${id}/calls`).set('Cookie', cookie(who)).send(body);
    const patch = (body: any, callId: string, who = GUEST, id = 'c1') => http().patch(`/api/conversations/${id}/calls/${callId}`).set('Cookie', cookie(who)).send(body);

    describe('POST /api/conversations/:id/calls', () => {
      it('starts a ringing call to the other party and notifies them', async () => {
        const res = await start({ kind: 'video' }).expect(201);
        expect(res.body).toMatchObject({ success: true, message: 'Call started.', kind: 'video', status: 'ringing' });
        expect(calls.rows[0]).toMatchObject({ caller_id: GUEST, callee_id: HOST, conversation_id: 'c1' });
        expect(notify).toHaveBeenCalledWith('call.incoming', HOST, expect.objectContaining({ senderName: 'Gita Guest' }));
      });

      it('403 for a non-participant', async () => {
        expectError(await start({ kind: 'voice' }, STRANGER), 403);
        expect(calls.rows).toHaveLength(0);
      });

      it('404 for an unknown conversation', async () => {
        expectError(await start({ kind: 'voice' }, GUEST, 'nope'), 404);
      });

      it.each([
        ['missing kind', {}],
        ['unknown kind', { kind: 'hologram' }],
        ['wrong case', { kind: 'Voice' }],
      ])('400 for %s (DTO validation)', async (_l, body) => {
        expectError(await start(body), 400, /kind must be one of the following values: voice, video/);
        expect(calls.rows).toHaveLength(0);
      });
    });

    describe('PATCH /api/conversations/:id/calls/:callId', () => {
      let callId: string;
      beforeEach(async () => {
        callId = (await start({ kind: 'voice' })).body.id;
      });

      it('accepting a call updates status without writing a history message', async () => {
        const res = await patch({ status: 'accepted' }, callId, HOST).expect(200);
        expect(res.body).toEqual({ success: true, message: 'Call updated.' });
        expect(calls.rows[0].status).toBe('accepted');
        expect(messages.rows).toHaveLength(0);
      });

      it('declining records "declined" history sent as the caller', async () => {
        await patch({ status: 'declined' }, callId, HOST).expect(200);
        expect(calls.rows[0].ended_at).toBeInstanceOf(Date);
        expect(messages.rows[0]).toMatchObject({ body: 'Voice call declined', type: 'call', call_id: callId, sender_id: GUEST });
      });

      it('ending a call that was never answered is recorded as missed', async () => {
        await patch({ status: 'ended' }, callId).expect(200);
        expect(messages.rows[0].body).toBe('Missed voice call');
      });

      it('ending an answered call records its duration', async () => {
        calls.rows[0].started_at = new Date(Date.now() - 65_000);
        await patch({ status: 'accepted' }, callId, HOST).expect(200);
        await patch({ status: 'ended' }, callId).expect(200);
        expect(messages.rows[0].body).toMatch(/^Voice call · 1:0[4-9]$/);
      });

      it('403 for a non-participant of the conversation', async () => {
        expectError(await patch({ status: 'ended' }, callId, STRANGER), 403);
        expect(calls.rows[0].status).toBe('ringing');
      });

      it('404 for an unknown call', async () => {
        expectError(await patch({ status: 'ended' }, 'nope'), 404, /Call not found/);
      });

      it('404 when the call belongs to a different conversation the caller is in', async () => {
        conversations.rows.push({ id: 'c3', listing_id: LISTING, guest_id: GUEST, host_id: HOST });
        expectError(await patch({ status: 'ended' }, callId, GUEST, 'c3'), 404, /Call not found/);
      });

      it('404 for an unknown conversation', async () => {
        expectError(await patch({ status: 'ended' }, callId, GUEST, 'nope'), 404, /Conversation not found/);
      });

      it.each([
        ['missing status', {}],
        ['unknown status', { status: 'ringing' }],
        ['non-string status', { status: 1 }],
      ])('400 for %s (DTO validation)', async (_l, body) => {
        expectError(await patch(body, callId), 400, /status must be one of the following values: accepted, declined, missed, ended/);
      });
    });
  });

  /* ── Reviews ─────────────────────────────────────────────────────────── */

  describe('POST /api/reviews/booking/:bookingId', () => {
    const review = (bookingId: string, body: any, who = GUEST) => http().post(`/api/reviews/booking/${bookingId}`).set('Cookie', cookie(who)).send(body);
    const good = { rating: 5, content: 'Lovely stay' };

    it('guest reviews the host of a completed stay (attached to the listing)', async () => {
      const res = await review('b-done', good).expect(201);
      expect(res.body).toEqual({ success: true, message: 'Thanks for your review.' });
      expect(reviews.rows[0]).toMatchObject({ booking_id: 'b-done', author_id: GUEST, target_user_id: HOST, listing_id: LISTING, role: 'guest_reviewing_host', rating: 5, content: 'Lovely stay' });
    });

    it('host reviews the guest of a checked-out stay (no listing attached)', async () => {
      await review('b-out', { rating: 4, content: 'Tidy' }, HOST).expect(201);
      expect(reviews.rows[0]).toMatchObject({ author_id: HOST, target_user_id: GUEST, listing_id: null, role: 'host_reviewing_guest' });
    });

    it('both parties can each review the same booking once', async () => {
      await review('b-done', good).expect(201);
      await review('b-done', good, HOST).expect(201);
      expect(reviews.rows).toHaveLength(2);
    });

    it('409 on a duplicate review by the same author', async () => {
      await review('b-done', good).expect(201);
      expectError(await review('b-done', { rating: 1, content: 'changed my mind' }), 409, /already reviewed/);
      expect(reviews.rows).toHaveLength(1);
    });

    it('409 when the DB unique constraint wins a double-submit race', async () => {
      jest.spyOn(reviews, 'insert').mockRejectedValueOnce({ code: '23505' });
      expectError(await review('b-done', good), 409, /already reviewed/);
    });

    it('a non-unique DB failure is answered as a generic 500 with no internals', async () => {
      jest.spyOn(reviews, 'insert').mockRejectedValueOnce(new Error('connection reset to 10.0.0.5'));
      const res = await review('b-done', good);
      expectError(res, 500, 'Something went wrong');
      expect(res.body.message).not.toMatch(/10\.0\.0\.5/);
    });

    it('403 for someone who is not a party to the booking', async () => {
      expectError(await review('b-done', good, STRANGER), 403, /not a party/);
      expect(reviews.rows).toHaveLength(0);
    });

    it('400 for a booking that is not completed or checked out', async () => {
      expectError(await review('b-pending', good), 400, /completed or checked out/);
    });

    it('404 for an unknown booking', async () => {
      expectError(await review('missing', good), 404, /Booking not found/);
    });

    it.each([
      ['rating 0', { rating: 0, content: 'x' }, /rating must not be less than 1/],
      ['rating 6', { rating: 6, content: 'x' }, /rating must not be greater than 5/],
      ['fractional rating', { rating: 4.5, content: 'x' }, /rating must be an integer/],
      ['string rating', { rating: '5', content: 'x' }, /rating must be an integer/],
      ['missing rating', { content: 'x' }, /rating must be an integer/],
      ['missing content', { rating: 5 }, /content should not be empty/],
      ['empty content', { rating: 5, content: '' }, /content should not be empty/],
      ['non-string content', { rating: 5, content: 7 }, /content must be a string/],
      ['empty body', {}, /rating/],
    ])('400 for %s (DTO validation)', async (_l, body, msg) => {
      expectError(await review('b-done', body), 400, msg);
      expect(reviews.rows).toHaveLength(0);
    });

    it('does not let the client choose author, target or role (whitelist)', async () => {
      await review('b-done', { ...good, author_id: HOST, role: 'host_reviewing_guest', target_user_id: STRANGER }).expect(201);
      expect(reviews.rows[0]).toMatchObject({ author_id: GUEST, target_user_id: HOST, role: 'guest_reviewing_host' });
    });
  });

  describe('GET /api/reviews/listing/:listingId (public)', () => {
    it('returns an empty list without authentication when there are no reviews', async () => {
      const res = await http().get(`/api/reviews/listing/${LISTING}`).expect(200);
      expect(res.body).toEqual({ success: true, reviews: [] });
    });

    it('returns guest-to-host reviews newest first with author name/avatar, and hides host-to-guest reviews', async () => {
      reviews.rows.push(
        { id: 'r1', listing_id: LISTING, role: 'guest_reviewing_host', author_id: GUEST, rating: 5, content: 'old', created_at: new Date('2026-01-01') },
        { id: 'r2', listing_id: LISTING, role: 'guest_reviewing_host', author_id: STRANGER, rating: 3, content: 'new', created_at: new Date('2026-03-01') },
        { id: 'r3', listing_id: LISTING, role: 'host_reviewing_guest', author_id: HOST, rating: 1, content: 'private', created_at: new Date('2026-02-01') },
        { id: 'r4', listing_id: 'other-listing', role: 'guest_reviewing_host', author_id: GUEST, rating: 2, content: 'elsewhere', created_at: new Date('2026-02-01') },
      );
      const res = await http().get(`/api/reviews/listing/${LISTING}`).expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reviews.map((r: any) => r.id)).toEqual(['r2', 'r1']);
      expect(res.body.reviews[1]).toMatchObject({ rating: 5, content: 'old', authorName: 'Gita Guest', authorAvatar: 'g.png' });
      expect(res.body.reviews[0]).toMatchObject({ authorName: 'Guest', authorAvatar: null }); // unknown author fallback
    });

    it('an unknown listing simply has no reviews (200, not 404)', async () => {
      const res = await http().get('/api/reviews/listing/does-not-exist').expect(200);
      expect(res.body.reviews).toEqual([]);
    });

    it('end to end: a review posted through the API shows up in the listing feed', async () => {
      await http().post('/api/reviews/booking/b-done').set('Cookie', cookie(GUEST)).send({ rating: 4, content: 'Nice' }).expect(201);
      const res = await http().get(`/api/reviews/listing/${LISTING}`).expect(200);
      expect(res.body.reviews).toHaveLength(1);
      expect(res.body.reviews[0]).toMatchObject({ rating: 4, content: 'Nice', authorName: 'Gita Guest' });
    });
  });

  /* ── Notifications ───────────────────────────────────────────────────── */

  describe('notifications', () => {
    const seed = (n: number, userId = GUEST, extra: Record<string, any> = {}) => {
      for (let i = 0; i < n; i++) {
        notifLog.rows.push({
          id: `00000000-0000-4000-8000-${String(1000 + notifLog.rows.length).padStart(12, '0')}`,
          user_id: userId,
          event: 'booking.requested',
          channel: 'push',
          status: 'sent',
          payload: { listingTitle: 'Sea View Flat', link: '/host/bookings', pushTitle: 'stale' },
          sent_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
          read_at: null,
          ...extra,
        });
      }
    };

    describe('GET /api/notifications', () => {
      const list = (qs = '', who = GUEST) => http().get(`/api/notifications${qs}`).set('Cookie', cookie(who));

      it('returns an empty inbox', async () => {
        const res = await list().expect(200);
        expect(res.body).toEqual({ success: true, notifications: [], nextCursor: null });
      });

      it('returns only the caller\'s push notifications, newest first, with derived copy', async () => {
        seed(2);
        seed(1, STRANGER);
        seed(1, GUEST, { channel: 'email' });
        const res = await list().expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.notifications).toHaveLength(2);
        expect(new Date(res.body.notifications[0].sentAt).getTime()).toBeGreaterThan(new Date(res.body.notifications[1].sentAt).getTime());
        expect(res.body.notifications[0]).toMatchObject({
          event: 'booking.requested',
          channel: 'push',
          status: 'sent',
          title: 'New booking request',
          body: 'Someone wants to stay at Sea View Flat', // derived from the catalog, not stored pushTitle
          link: '/host/bookings',
          readAt: null,
        });
        expect(res.body.nextCursor).toBeNull();
      });

      it('falls back to "/" link and event name for unknown events', async () => {
        seed(1, GUEST, { event: 'weird.event', payload: {} });
        const res = await list().expect(200);
        expect(res.body.notifications[0]).toMatchObject({ title: 'weird.event', body: '', link: '/' });
      });

      it('paginates 10 at a time with a stable cursor', async () => {
        seed(12);
        const first = await list().expect(200);
        expect(first.body.notifications).toHaveLength(10);
        expect(first.body.nextCursor).toEqual({ before: first.body.notifications[9].sentAt, beforeId: first.body.notifications[9].id });

        const { before, beforeId } = first.body.nextCursor;
        const second = await list(`?before=${encodeURIComponent(before)}&beforeId=${beforeId}`).expect(200);
        expect(second.body.notifications).toHaveLength(2);
        expect(second.body.nextCursor).toBeNull();
        const ids = [...first.body.notifications, ...second.body.notifications].map((n: any) => n.id);
        expect(new Set(ids).size).toBe(12);
      });

      it('renders copy in Hindi for locale=hi and falls back to English for unsupported locales', async () => {
        seed(1);
        const hi = await list('?locale=hi').expect(200);
        expect(hi.body.notifications[0].title).toBe('नया बुकिंग अनुरोध');
        const xx = await list('?locale=klingon').expect(200);
        expect(xx.body.notifications[0].title).toBe('New booking request');
      });

      it.each([
        ['non-ISO before', '?before=yesterday&beforeId=' + MISSING_UUID, /before must be a valid ISO 8601/],
        ['non-UUID beforeId', '?before=2026-01-01T00:00:00Z&beforeId=abc', /beforeId must be a UUID/],
      ])('400 for %s (query validation)', async (_l, qs, msg) => {
        expectError(await list(qs), 400, msg);
      });
    });

    describe('GET /api/notifications/unread-count', () => {
      it('is 0 for an empty inbox', async () => {
        const res = await http().get('/api/notifications/unread-count').set('Cookie', cookie(GUEST)).expect(200);
        expect(res.body).toEqual({ success: true, count: 0 });
      });

      it('counts only the caller\'s unread push notifications', async () => {
        seed(3);
        seed(1, GUEST, { read_at: new Date() });
        seed(1, GUEST, { channel: 'email' });
        seed(4, STRANGER);
        const res = await http().get('/api/notifications/unread-count').set('Cookie', cookie(GUEST)).expect(200);
        expect(res.body).toEqual({ success: true, count: 3 });
      });
    });

    describe('POST /api/notifications/mark-read', () => {
      const mark = (body: any, who = GUEST) => http().post('/api/notifications/mark-read').set('Cookie', cookie(who)).send(body);
      const count = async (who = GUEST) => (await http().get('/api/notifications/unread-count').set('Cookie', cookie(who))).body.count;

      it('marks a single notification read', async () => {
        seed(3);
        const target = notifLog.rows[1].id;
        const res = await mark({ id: target }).expect(201);
        expect(res.body).toEqual({ success: true, message: 'Notifications marked as read.' });
        expect(await count()).toBe(2);
        expect(notifLog.rows[1].read_at).toBeInstanceOf(Date);
      });

      it('marks all of the caller\'s notifications read and leaves other users alone', async () => {
        seed(3);
        seed(2, STRANGER);
        await mark({ all: true }).expect(201);
        expect(await count()).toBe(0);
        expect(await count(STRANGER)).toBe(2);
      });

      it('cannot mark another user\'s notification by id (scoped to the caller; no effect)', async () => {
        seed(1, STRANGER);
        await mark({ id: notifLog.rows[0].id }).expect(201);
        expect(notifLog.rows[0].read_at).toBeNull();
      });

      it('the read state shows up in the inbox listing', async () => {
        seed(1);
        await mark({ all: true }).expect(201);
        const res = await http().get('/api/notifications').set('Cookie', cookie(GUEST)).expect(200);
        expect(res.body.notifications[0].readAt).not.toBeNull();
      });

      it.each([
        ['empty body', {}],
        ['both id and all', { id: MISSING_UUID, all: true }],
        ['all:false alone', { all: false }],
      ])('400 for %s', async (_l, body) => {
        expectError(await mark(body), 400, /Pass either \{ id \} or \{ all: true \}/);
      });

      it.each([
        ['non-UUID id', { id: 'abc' }, /id must be a UUID/],
        ['non-boolean all', { all: 'yes' }, /all must be a boolean/],
      ])('400 for %s (DTO validation)', async (_l, body, msg) => {
        expectError(await mark(body), 400, msg);
      });
    });
  });

  /* ── Storage ─────────────────────────────────────────────────────────── */

  describe('POST /api/storage/upload-url', () => {
    const up = (body: any, who = GUEST) => http().post('/api/storage/upload-url').set('Cookie', cookie(who)).send(body);

    it('returns a signed URL scoped under the caller\'s user id in the default bucket', async () => {
      const res = await up({ fileName: 'id.png', fileType: 'image/png' }).expect(201);
      expect(res.body).toMatchObject({ success: true, message: 'Upload link created.', path: `${GUEST}/id.png` });
      expect(res.body.url).toBe(`https://signed.test/kyc-documents/${GUEST}/id.png?t=1`);
      expect(uploadCalls).toEqual([{ bucket: 'kyc-documents', path: `${GUEST}/id.png` }]);
    });

    it('honours an explicit bucket', async () => {
      await up({ fileName: 'a.jpg', bucket: 'listing-photos' }).expect(201);
      expect(uploadCalls[0].bucket).toBe('listing-photos');
    });

    it('the path always starts with the token\'s user, never one supplied in the body', async () => {
      await up({ fileName: 'a.jpg', userId: STRANGER }).expect(201);
      expect(uploadCalls[0].path).toBe(`${GUEST}/a.jpg`);
    });

    it('500 with the storage error message when Supabase refuses', async () => {
      storageError = { message: 'Bucket not found' };
      expectError(await up({ fileName: 'a.jpg', bucket: 'nope' }), 500, /Bucket not found/);
    });

    it.each([
      ['missing fileName', {}, /fileName must be a string/],
      ['empty fileName', { fileName: '' }, /fileName must be longer than or equal to 1/],
      ['non-string fileName', { fileName: 42 }, /fileName must be a string/],
      ['non-string bucket', { fileName: 'a', bucket: 5 }, /bucket must be a string/],
      ['non-string fileType', { fileName: 'a', fileType: 5 }, /fileType must be a string/],
    ])('400 for %s (DTO validation)', async (_l, body, msg) => {
      expectError(await up(body), 400, msg);
      expect(uploadCalls).toHaveLength(0);
    });

    // BUG (reported, src untouched): fileName is concatenated into the object path unchecked, so a
    // signed upload URL can be minted for ANOTHER user's folder via "../<victim>/file".
    it.failing('BUG: rejects path-traversal in fileName instead of minting a URL outside the caller\'s folder', async () => {
      const res = await up({ fileName: `../${STRANGER}/passport.png` });
      expect(res.status).toBe(400);
    });

    // BUG (reported): any authenticated user can choose any bucket, including private ones
    // such as "verification-documents", with no allow-list.
    it.failing('BUG: rejects a bucket outside an allow-list (e.g. the private verification-documents bucket)', async () => {
      const res = await up({ fileName: 'a.png', bucket: 'verification-documents' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  /* ── Reported data-quality bug ───────────────────────────────────────── */

  // BUG (reported): "   " passes @IsNotEmpty, so a whitespace-only review/message body is accepted.
  it.failing('BUG: rejects a whitespace-only review content', async () => {
    const res = await http().post('/api/reviews/booking/b-done').set('Cookie', cookie(GUEST)).send({ rating: 5, content: '   ' });
    expect(res.status).toBe(400);
  });
});
