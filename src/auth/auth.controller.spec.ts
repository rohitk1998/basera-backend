import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';

const JWT_SECRET = 'test-secret';

function mockResponse(): jest.Mocked<Response> {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as jest.Mocked<Response>;
}

function mockAuthService() {
  return {
    verifyFirebaseToken: jest.fn(),
    firebaseUidToUserId: jest.fn((uid: string) => `user-for-${uid}`),
    findProfileById: jest.fn(),
    findProfileByEmail: jest.fn(),
    verifyAdminCredentials: jest.fn(),
    sendEmailOtp: jest.fn(),
    verifyEmailOtp: jest.fn(),
    completeSignup: jest.fn(),
    verifyRefreshToken: jest.fn(),
    revokeRefreshToken: jest.fn(),
    issueSession: jest.fn(async () => ({
      accessToken: jwt.sign({ sub: 'user-1' }, JWT_SECRET),
      refreshToken: 'raw-refresh-token',
      deviceId: 'device-1',
    })),
    issueProofToken: jest.fn(
      (opts: Record<string, unknown>) => jwt.sign({ purpose: 'profile-completion', ...opts }, JWT_SECRET, { expiresIn: '10m' }),
    ),
  };
}

// AuthController is now a thin HTTP layer: it reads the request, delegates
// every actual decision to AuthService, and writes cookies from whatever
// AuthService returns. These tests check that wiring — the business-logic
// cases (bcrypt, OTP validation, signup races, etc.) now live in
// auth.service.spec.ts against AuthService directly.
describe('AuthController', () => {
  let controller: AuthController;
  let auth: ReturnType<typeof mockAuthService>;

  beforeEach(async () => {
    auth = mockAuthService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    })
      // realtimeToken is @UseGuards(AuthGuard) — these tests call the
      // controller method directly rather than through Nest's HTTP
      // pipeline, so the guard never actually runs regardless; overriding
      // it here just satisfies module compilation (AuthGuard needs a real
      // ConfigService this test has no reason to provide).
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuthController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('session (phone-OTP)', () => {
    it('rejects a missing firebaseToken without calling AuthService', async () => {
      await expect(controller.session(undefined as any, mockResponse())).rejects.toThrow(BadRequestException);
      expect(auth.verifyFirebaseToken).not.toHaveBeenCalled();
    });

    it('rejects a token with no phone number', async () => {
      auth.verifyFirebaseToken.mockResolvedValue({ uid: 'uid-1' });
      await expect(controller.session('token', mockResponse())).rejects.toThrow('No phone number found on token');
    });

    it('returns a proofToken (no session cookie) for a brand-new signup', async () => {
      auth.verifyFirebaseToken.mockResolvedValue({ uid: 'uid-1', phone_number: '+911234567890' });
      auth.findProfileById.mockResolvedValue(null);
      const res = mockResponse();

      const result = await controller.session('token', res);

      expect(result.isNewUser).toBe(true);
      expect(result.proofToken).toEqual(expect.any(String));
      expect(res.cookie).not.toHaveBeenCalled();
      expect(auth.issueSession).not.toHaveBeenCalled();
    });

    it('issues a session for an existing, completed profile', async () => {
      auth.verifyFirebaseToken.mockResolvedValue({ uid: 'uid-1', phone_number: '+911234567890' });
      auth.findProfileById.mockResolvedValue({ id: 'user-for-uid-1', full_name: 'Jane', phone: '+911234567890' });
      const res = mockResponse();

      const result = await controller.session('token', res);

      expect(result.isNewUser).toBe(false);
      expect(auth.issueSession).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-for-uid-1', phone: '+911234567890', firebaseUid: 'uid-1' }),
      );
      expect(res.cookie).toHaveBeenCalled();
    });

    it('treats an existing row with no full_name as isNewUser but still issues a session', async () => {
      auth.verifyFirebaseToken.mockResolvedValue({ uid: 'uid-1', phone_number: '+911234567890' });
      auth.findProfileById.mockResolvedValue({ id: 'user-1', full_name: null, phone: '+911234567890' });
      const res = mockResponse();

      const result = await controller.session('token', res);

      expect(result.isNewUser).toBe(true);
      expect(res.cookie).toHaveBeenCalled();
    });
  });

  describe('adminLogin', () => {
    it('issues a session and redirects to /admin on correct credentials', async () => {
      auth.verifyAdminCredentials.mockResolvedValue({ id: 'admin-1', phone: null });
      const res = mockResponse();

      const result = await controller.adminLogin({ email: 'x@x.com', password: 'correct-password' }, res);

      expect(result).toEqual({ success: true, redirectTo: '/admin' });
      expect(auth.verifyAdminCredentials).toHaveBeenCalledWith('x@x.com', 'correct-password');
      expect(res.cookie).toHaveBeenCalled();
    });

    it('propagates AuthService rejection (e.g. wrong password) without issuing a session', async () => {
      auth.verifyAdminCredentials.mockRejectedValue(new UnauthorizedException('Invalid email or password'));
      await expect(
        controller.adminLogin({ email: 'x@x.com', password: 'wrong' }, mockResponse()),
      ).rejects.toThrow(UnauthorizedException);
      expect(auth.issueSession).not.toHaveBeenCalled();
    });
  });

  describe('sendEmailOtp', () => {
    it('delegates to AuthService and returns success', async () => {
      auth.sendEmailOtp.mockResolvedValue(undefined);
      const result = await controller.sendEmailOtp({ email: 'test@example.com' });
      expect(result).toEqual({ success: true });
      expect(auth.sendEmailOtp).toHaveBeenCalledWith('test@example.com');
    });
  });

  describe('verifyEmailOtp', () => {
    it('returns a proofToken (no session cookie) for a brand-new signup', async () => {
      auth.verifyEmailOtp.mockResolvedValue({ isNewUser: true, email: 'test@example.com' });
      const res = mockResponse();

      const result = await controller.verifyEmailOtp({ email: 'test@example.com', code: '123456' }, res);

      expect(result.isNewUser).toBe(true);
      expect(result.proofToken).toEqual(expect.any(String));
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('issues a session for an existing completed profile on correct code', async () => {
      auth.verifyEmailOtp.mockResolvedValue({
        isNewUser: false,
        profile: { id: 'user-1', full_name: 'Jane', phone: null },
      });
      const res = mockResponse();

      const result = await controller.verifyEmailOtp({ email: 'test@example.com', code: '123456' }, res);

      expect(result.isNewUser).toBe(false);
      expect(res.cookie).toHaveBeenCalled();
    });
  });

  // completeSignup is now a multipart endpoint (the picked avatar, if any,
  // rides along in the same request — see AuthService.completeSignup's doc
  // comment) — Nest binds each multipart field with its own @Body(field)
  // decorator rather than one @Body() DTO, so these tests call the method
  // with that same expanded argument list.
  describe('completeSignup', () => {
    it('issues a session using whatever AuthService resolves the signup to', async () => {
      auth.completeSignup.mockResolvedValue({
        userId: 'user-1',
        phone: '+91123',
        firebaseUid: 'uid-1',
        avatar_url: 'https://cdn.example/avatar.jpg',
      });
      const res = mockResponse();

      const result = await controller.completeSignup(
        'Jane',
        'jane@example.com',
        JSON.stringify(['en']),
        'false',
        'token',
        undefined,
        res,
      );

      expect(result).toEqual({ success: true, avatar_url: 'https://cdn.example/avatar.jpg' });
      expect(auth.issueSession).toHaveBeenCalledWith({ userId: 'user-1', phone: '+91123', firebaseUid: 'uid-1' });
      expect(res.cookie).toHaveBeenCalled();
    });

    it('rejects an invalid body (e.g. missing name) before ever calling AuthService', async () => {
      await expect(
        controller.completeSignup('', 'a@a.com', JSON.stringify(['en']), 'false', 'token', undefined, mockResponse()),
      ).rejects.toThrow(BadRequestException);
      expect(auth.completeSignup).not.toHaveBeenCalled();
    });

    it('propagates AuthService rejection (e.g. invalid proofToken, or an avatar upload failure that rolled back the new account) without issuing a session', async () => {
      auth.completeSignup.mockRejectedValue(new UnauthorizedException());
      await expect(
        controller.completeSignup('Alice', 'a@a.com', JSON.stringify(['en']), 'false', 'bad', undefined, mockResponse()),
      ).rejects.toThrow(UnauthorizedException);
      expect(auth.issueSession).not.toHaveBeenCalled();
    });

    it('passes the uploaded file through to AuthService when one is attached', async () => {
      auth.completeSignup.mockResolvedValue({ userId: 'user-1', avatar_url: 'https://cdn.example/avatar.jpg' });
      const file = { buffer: Buffer.from('fake-image-bytes'), mimetype: 'image/jpeg', size: 2 * 1024 * 1024 };

      await controller.completeSignup('Jane', 'jane@example.com', JSON.stringify(['en']), 'false', 'token', file, mockResponse());

      expect(auth.completeSignup).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ mimetype: 'image/jpeg', size: file.size }),
      );
    });
  });

  describe('refresh', () => {
    function req(cookies: Record<string, string>) {
      return { cookies } as any;
    }

    it('rejects when there is no refresh token cookie', async () => {
      await expect(controller.refresh(req({}), mockResponse())).rejects.toThrow(UnauthorizedException);
      expect(auth.verifyRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects when the (expired) access token has no sub claim to identify the user', async () => {
      const noSubToken = jwt.sign({ foo: 'bar' }, JWT_SECRET);
      await expect(
        controller.refresh(
          req({
            basera_refresh_token: 'raw-refresh-token',
            'sb-dkmlkbhwzvexwdgxpexg-auth-token': JSON.stringify({ access_token: noSubToken }),
          }),
          mockResponse(),
        ),
      ).rejects.toThrow('No session to refresh');
    });

    it('issues a new session when AuthService confirms the refresh token', async () => {
      const accessToken = jwt.sign({ sub: 'user-1' }, JWT_SECRET, { expiresIn: '-1h' });
      auth.verifyRefreshToken.mockResolvedValue({ id: 'user-1', phone: '+91123' });
      const res = mockResponse();

      const result = await controller.refresh(
        req({
          basera_refresh_token: 'raw-refresh-token',
          'sb-dkmlkbhwzvexwdgxpexg-auth-token': JSON.stringify({ access_token: accessToken }),
        }),
        res,
      );

      expect(result).toEqual({ success: true });
      expect(auth.verifyRefreshToken).toHaveBeenCalledWith('user-1', 'raw-refresh-token');
      expect(res.cookie).toHaveBeenCalled();
    });

    it('propagates AuthService rejection (e.g. expired/mismatched refresh token)', async () => {
      const accessToken = jwt.sign({ sub: 'user-1' }, JWT_SECRET, { expiresIn: '-1h' });
      auth.verifyRefreshToken.mockRejectedValue(new UnauthorizedException('Invalid or expired refresh token'));

      await expect(
        controller.refresh(
          req({
            basera_refresh_token: 'raw-refresh-token',
            'sb-dkmlkbhwzvexwdgxpexg-auth-token': JSON.stringify({ access_token: accessToken }),
          }),
          mockResponse(),
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('clears all session cookies even with no session present', async () => {
      const res = mockResponse();
      const result = await controller.logout({ cookies: {} } as any, res);

      expect(result).toEqual({ success: true });
      expect(res.clearCookie).toHaveBeenCalledTimes(4);
      expect(auth.revokeRefreshToken).not.toHaveBeenCalled();
    });

    it('revokes the refresh token server-side when a session is present', async () => {
      const accessToken = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
      const res = mockResponse();

      const result = await controller.logout(
        { cookies: { 'sb-dkmlkbhwzvexwdgxpexg-auth-token': JSON.stringify({ access_token: accessToken }) } } as any,
        res,
      );

      expect(result).toEqual({ success: true });
      expect(auth.revokeRefreshToken).toHaveBeenCalledWith('user-1');
    });
  });

  describe('realtimeToken', () => {
    it('returns the access token parsed out of the session cookie', () => {
      const accessToken = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
      const req = {
        cookies: { 'sb-dkmlkbhwzvexwdgxpexg-auth-token': JSON.stringify({ access_token: accessToken }) },
      } as any;

      const result = controller.realtimeToken(req);
      expect(result).toEqual({ token: accessToken });
    });

    it('returns the raw cookie value as-is when it is not JSON', () => {
      const req = { cookies: { 'sb-dkmlkbhwzvexwdgxpexg-auth-token': 'bare-token-value' } } as any;
      const result = controller.realtimeToken(req);
      expect(result).toEqual({ token: 'bare-token-value' });
    });
  });
});
