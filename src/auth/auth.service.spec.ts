import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, HttpException, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { UserEntity, EmailOtpEntity } from '../entities';
import { NotificationsService } from '../notifications/notifications.service';
import { UserService } from '../user/user.service';

const JWT_SECRET = 'test-secret';

function mockRepo<T extends object>(): jest.Mocked<any> {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x) => x),
    update: jest.fn(),
    delete: jest.fn(),
    insert: jest.fn(),
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let profiles: ReturnType<typeof mockRepo<UserEntity>>;
  let emailOtps: ReturnType<typeof mockRepo<EmailOtpEntity>>;
  let firebase: { auth: { verifyIdToken: jest.Mock } };
  let notifications: { sendEmailOtpViaSmtp: jest.Mock };
  let userService: { validateAvatarFile: jest.Mock; uploadAvatarToStorage: jest.Mock };

  beforeEach(async () => {
    profiles = mockRepo<UserEntity>();
    emailOtps = mockRepo<EmailOtpEntity>();
    firebase = { auth: { verifyIdToken: jest.fn() } };
    notifications = { sendEmailOtpViaSmtp: jest.fn() };
    userService = {
      validateAvatarFile: jest.fn(),
      uploadAvatarToStorage: jest.fn().mockResolvedValue('https://cdn.example/avatar.jpg'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: FirebaseAdminProvider, useValue: firebase },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => (key === 'SUPABASE_JWT_SECRET' ? JWT_SECRET : undefined)) },
        },
        { provide: getRepositoryToken(UserEntity), useValue: profiles },
        { provide: getRepositoryToken(EmailOtpEntity), useValue: emailOtps },
        { provide: NotificationsService, useValue: notifications },
        { provide: UserService, useValue: userService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('verifyFirebaseToken', () => {
    it('rejects an invalid Firebase token with the auth/* code as a 400', async () => {
      firebase.auth.verifyIdToken.mockRejectedValue({ code: 'auth/id-token-expired' });
      await expect(service.verifyFirebaseToken('bad-token')).rejects.toThrow('auth/id-token-expired');
    });

    it('surfaces a non-auth/* Firebase failure as a 500, not a mislabeled 400', async () => {
      firebase.auth.verifyIdToken.mockRejectedValue(new Error('network blip'));
      await expect(service.verifyFirebaseToken('token')).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('session issuance (phone-OTP path, via firebaseUidToUserId + issueSession)', () => {
    it('returns a proofToken (no DB session write) for a brand-new signup', () => {
      const proofToken = service.issueProofToken({ phone: '+911234567890', firebaseUid: 'uid-1' });
      expect(proofToken).toEqual(expect.any(String));

      const decoded = jwt.verify(proofToken, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded.purpose).toBe('profile-completion');
      expect(decoded.sub).toBeUndefined();
    });

    it('issueSession writes a refresh token hash and signs a session JWT', async () => {
      const tokens = await service.issueSession({ userId: 'user-1', phone: '+911234567890' });

      expect(tokens.accessToken).toEqual(expect.any(String));
      expect(tokens.refreshToken).toEqual(expect.any(String));
      expect(profiles.update).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ refresh_token_hash: expect.any(String) }),
      );

      const decoded = jwt.verify(tokens.accessToken, JWT_SECRET) as jwt.JwtPayload;
      expect(decoded.sub).toBe('user-1');
    });
  });

  describe('verifyAdminCredentials', () => {
    it('rejects when no profile exists for the email', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.verifyAdminCredentials('x@x.com', 'pw')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a non-admin profile with the same generic message', async () => {
      profiles.findOne.mockResolvedValue({ role: 'guest', password_hash: 'hash' });
      await expect(service.verifyAdminCredentials('x@x.com', 'pw')).rejects.toThrow('Invalid email or password');
    });

    it('rejects an admin profile with no password_hash set', async () => {
      profiles.findOne.mockResolvedValue({ role: 'admin', password_hash: null });
      await expect(service.verifyAdminCredentials('x@x.com', 'pw')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a wrong password', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      profiles.findOne.mockResolvedValue({ id: 'admin-1', role: 'admin', password_hash: hash });
      await expect(service.verifyAdminCredentials('x@x.com', 'wrong')).rejects.toThrow(UnauthorizedException);
    });

    it('returns the profile on correct credentials', async () => {
      const hash = await bcrypt.hash('correct-password', 4);
      profiles.findOne.mockResolvedValue({ id: 'admin-1', role: 'admin', password_hash: hash, phone: null });

      const result = await service.verifyAdminCredentials('x@x.com', 'correct-password');
      expect(result).toEqual(expect.objectContaining({ id: 'admin-1' }));
    });
  });

  describe('sendEmailOtp', () => {
    it('sends and persists a new OTP row when none exists', async () => {
      emailOtps.findOne.mockResolvedValue(null);
      notifications.sendEmailOtpViaSmtp.mockResolvedValue(undefined);

      await service.sendEmailOtp('Test@Example.com');

      expect(notifications.sendEmailOtpViaSmtp).toHaveBeenCalledWith(
        'test@example.com',
        expect.objectContaining({ code: expect.any(String) }),
      );
      expect(emailOtps.save).toHaveBeenCalled();
    });

    it('rejects a resend within the debounce window', async () => {
      emailOtps.findOne.mockResolvedValue({ email: 'test@example.com', last_sent_at: new Date() });
      await expect(service.sendEmailOtp('test@example.com')).rejects.toMatchObject({ status: 429 });
      await expect(service.sendEmailOtp('test@example.com')).rejects.toBeInstanceOf(HttpException);
      expect(notifications.sendEmailOtpViaSmtp).not.toHaveBeenCalled();
    });

    it('allows a resend once the debounce window has passed', async () => {
      emailOtps.findOne.mockResolvedValue({
        email: 'test@example.com',
        last_sent_at: new Date(Date.now() - 61_000),
      });
      notifications.sendEmailOtpViaSmtp.mockResolvedValue(undefined);
      await expect(service.sendEmailOtp('test@example.com')).resolves.toBeUndefined();
    });

    it('does not persist a row when SMTP send fails', async () => {
      emailOtps.findOne.mockResolvedValue(null);
      notifications.sendEmailOtpViaSmtp.mockRejectedValue(new Error('smtp down'));
      await expect(service.sendEmailOtp('test@example.com')).rejects.toThrow(InternalServerErrorException);
      expect(emailOtps.save).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmailOtp', () => {
    const email = 'test@example.com';
    const code = '123456';
    const codeHash = require('node:crypto').createHash('sha256').update(code).digest('hex');

    it('rejects when no OTP row exists', async () => {
      emailOtps.findOne.mockResolvedValue(null);
      await expect(service.verifyEmailOtp(email, code)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects and deletes an expired code', async () => {
      emailOtps.findOne.mockResolvedValue({
        email,
        code_hash: codeHash,
        expires_at: new Date(Date.now() - 1000),
        attempt_count: 0,
      });
      await expect(service.verifyEmailOtp(email, code)).rejects.toThrow('Invalid or expired code.');
      expect(emailOtps.delete).toHaveBeenCalledWith({ email });
    });

    it('rejects and deletes after exceeding max attempts', async () => {
      emailOtps.findOne.mockResolvedValue({
        email,
        code_hash: codeHash,
        expires_at: new Date(Date.now() + 60_000),
        attempt_count: 5,
      });
      await expect(service.verifyEmailOtp(email, code)).rejects.toThrow('Too many incorrect attempts. Request a new code.');
      expect(emailOtps.delete).toHaveBeenCalledWith({ email });
    });

    it('increments attempt_count on a wrong code without deleting the row', async () => {
      emailOtps.findOne.mockResolvedValue({
        email,
        code_hash: codeHash,
        expires_at: new Date(Date.now() + 60_000),
        attempt_count: 1,
      });
      await expect(service.verifyEmailOtp(email, '000000')).rejects.toThrow('Invalid or expired code.');
      expect(emailOtps.update).toHaveBeenCalledWith({ email }, { attempt_count: 2 });
      expect(emailOtps.delete).not.toHaveBeenCalled();
    });

    it('reports a brand-new signup (no profile row) on correct code', async () => {
      emailOtps.findOne.mockResolvedValue({
        email,
        code_hash: codeHash,
        expires_at: new Date(Date.now() + 60_000),
        attempt_count: 0,
      });
      profiles.findOne.mockResolvedValue(null);

      const result = await service.verifyEmailOtp(email, code);
      expect(result).toEqual({ isNewUser: true, email });
      expect(emailOtps.delete).toHaveBeenCalledWith({ email });
    });

    it('returns the existing completed profile on correct code', async () => {
      emailOtps.findOne.mockResolvedValue({
        email,
        code_hash: codeHash,
        expires_at: new Date(Date.now() + 60_000),
        attempt_count: 0,
      });
      profiles.findOne.mockResolvedValue({ id: 'user-1', full_name: 'Jane', phone: null });

      const result = await service.verifyEmailOtp(email, code);
      expect('profile' in result && result.isNewUser).toBe(false);
    });
  });

  describe('completeSignup', () => {
    function proofToken(claims: Record<string, unknown>) {
      return jwt.sign({ purpose: 'profile-completion', ...claims }, JWT_SECRET, { expiresIn: '10m' });
    }

    it('rejects an invalid/garbage proofToken', async () => {
      await expect(
        service.completeSignup({ proofToken: 'not-a-jwt', name: 'A', email: 'a@a.com', languages: ['en'] } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired proofToken', async () => {
      const expired = jwt.sign({ purpose: 'profile-completion', phone: '+91123' }, JWT_SECRET, { expiresIn: '-1s' });
      await expect(
        service.completeSignup({ proofToken: expired, name: 'A', email: 'a@a.com', languages: ['en'] } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token with the wrong purpose (e.g. a real session token)', async () => {
      const sessionLikeToken = jwt.sign({ sub: 'user-1' }, JWT_SECRET);
      await expect(
        service.completeSignup({ proofToken: sessionLikeToken, name: 'A', email: 'a@a.com', languages: ['en'] } as any),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('creates a new row for a phone-OTP signup', async () => {
      const token = proofToken({ phone: '+91123', firebaseUid: 'uid-1' });
      profiles.findOne.mockResolvedValue(null);
      profiles.insert.mockResolvedValue({});

      const result = await service.completeSignup({
        proofToken: token,
        name: 'Jane',
        email: 'jane@example.com',
        languages: ['en'],
      } as any);

      expect(result.userId).toEqual(expect.any(String));
      expect(profiles.insert).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+91123', full_name: 'Jane', email: 'jane@example.com' }),
      );
    });

    it('surfaces a ConflictException when the email is already taken (phone signup, new row)', async () => {
      const token = proofToken({ phone: '+91123', firebaseUid: 'uid-1' });
      profiles.findOne.mockResolvedValue(null);
      profiles.insert.mockRejectedValue({ code: '23505' });

      await expect(
        service.completeSignup({ proofToken: token, name: 'Jane', email: 'taken@example.com', languages: ['en'] } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('re-issues (update, not insert) for a replayed phone-OTP token whose row already exists', async () => {
      const token = proofToken({ phone: '+91123', firebaseUid: 'uid-1' });
      // userId is deterministic from firebaseUid (firebaseUidToSupabaseUuid),
      // not read off this mocked row — its `id` is irrelevant, only its
      // existence is what makes completeSignup take the update branch.
      profiles.findOne.mockResolvedValue({ id: 'some-existing-row' });
      profiles.update.mockResolvedValue({});

      const result = await service.completeSignup({
        proofToken: token,
        name: 'Jane',
        email: 'jane@example.com',
        languages: ['en'],
      } as any);

      expect(result.userId).toEqual(expect.any(String));
      expect(profiles.update).toHaveBeenCalledWith(result.userId, expect.any(Object));
      expect(profiles.insert).not.toHaveBeenCalled();
    });

    it('creates a new row for an email-OTP signup with a random id', async () => {
      const token = proofToken({ email: 'jane@example.com' });
      profiles.insert.mockResolvedValue({});

      const result = await service.completeSignup({
        proofToken: token,
        name: 'Jane',
        email: 'jane@example.com',
        languages: ['en'],
      } as any);

      expect(result.userId).toEqual(expect.any(String));
      expect(profiles.insert).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'jane@example.com', id: expect.any(String) }),
      );
    });

    it('falls back to the winning row on a concurrent email-OTP signup race', async () => {
      const token = proofToken({ email: 'jane@example.com' });
      profiles.insert.mockRejectedValue({ code: '23505' });
      profiles.findOne.mockResolvedValue({ id: 'winner-id' });
      profiles.update.mockResolvedValue({});

      const result = await service.completeSignup({
        proofToken: token,
        name: 'Jane',
        email: 'jane@example.com',
        languages: ['en'],
      } as any);

      expect(result.userId).toBe('winner-id');
      expect(profiles.update).toHaveBeenCalledWith('winner-id', expect.any(Object));
    });

    describe('with an avatar file', () => {
      const avatarFile = { buffer: Buffer.from('fake-image-bytes'), mimetype: 'image/jpeg', size: 2 * 1024 * 1024 };

      it('validates the file BEFORE touching the database at all', async () => {
        userService.validateAvatarFile.mockImplementation(() => {
          throw new BadRequestException('File too large. Maximum size is 5 MB.');
        });
        const token = proofToken({ email: 'jane@example.com' });

        await expect(
          service.completeSignup(
            { proofToken: token, name: 'Jane', email: 'jane@example.com', languages: ['en'] } as any,
            avatarFile,
          ),
        ).rejects.toThrow('File too large. Maximum size is 5 MB.');

        expect(profiles.insert).not.toHaveBeenCalled();
        expect(profiles.update).not.toHaveBeenCalled();
      });

      it('uploads after the row is created and returns the resulting avatar_url', async () => {
        const token = proofToken({ email: 'jane@example.com' });
        profiles.insert.mockResolvedValue({});
        profiles.update.mockResolvedValue({});

        const result = await service.completeSignup(
          { proofToken: token, name: 'Jane', email: 'jane@example.com', languages: ['en'] } as any,
          avatarFile,
        );

        expect(userService.uploadAvatarToStorage).toHaveBeenCalledWith(result.userId, avatarFile);
        expect(profiles.update).toHaveBeenCalledWith(result.userId, { avatar_url: 'https://cdn.example/avatar.jpg' });
        expect(result.avatar_url).toBe('https://cdn.example/avatar.jpg');
      });

      it('rolls back (deletes) the just-created row when the upload itself fails, for a brand-new email-OTP signup', async () => {
        const token = proofToken({ email: 'jane@example.com' });
        profiles.insert.mockResolvedValue({});
        userService.uploadAvatarToStorage.mockRejectedValue(new InternalServerErrorException('Upload failed. Please try again.'));

        await expect(
          service.completeSignup(
            { proofToken: token, name: 'Jane', email: 'jane@example.com', languages: ['en'] } as any,
            avatarFile,
          ),
        ).rejects.toThrow('Upload failed. Please try again.');

        expect(profiles.delete).toHaveBeenCalledWith({ id: expect.any(String) });
      });

      it('does NOT delete a pre-existing row on a replayed-token upload failure (only its own inserts get rolled back)', async () => {
        const token = proofToken({ phone: '+91123', firebaseUid: 'uid-1' });
        profiles.findOne.mockResolvedValue({ id: 'existing-row' });
        profiles.update.mockResolvedValue({});
        userService.uploadAvatarToStorage.mockRejectedValue(new InternalServerErrorException('Upload failed. Please try again.'));

        await expect(
          service.completeSignup(
            { proofToken: token, name: 'Jane', email: 'jane@example.com', languages: ['en'] } as any,
            avatarFile,
          ),
        ).rejects.toThrow('Upload failed. Please try again.');

        expect(profiles.delete).not.toHaveBeenCalled();
      });
    });
  });

  describe('verifyRefreshToken', () => {
    it('rejects when the profile has no matching/valid refresh token hash', async () => {
      profiles.findOne.mockResolvedValue({
        id: 'user-1',
        refresh_token_hash: 'some-other-hash',
        refresh_token_expires_at: new Date(Date.now() + 60_000),
      });
      await expect(service.verifyRefreshToken('user-1', 'raw-refresh-token')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when the refresh token has expired', async () => {
      const rawRefreshToken = 'raw-refresh-token';
      const tokenHash = require('node:crypto').createHash('sha256').update(rawRefreshToken).digest('hex');
      profiles.findOne.mockResolvedValue({
        id: 'user-1',
        refresh_token_hash: tokenHash,
        refresh_token_expires_at: new Date(Date.now() - 1000),
      });
      await expect(service.verifyRefreshToken('user-1', rawRefreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('returns the profile when the refresh token matches and is unexpired', async () => {
      const rawRefreshToken = 'raw-refresh-token';
      const tokenHash = require('node:crypto').createHash('sha256').update(rawRefreshToken).digest('hex');
      profiles.findOne.mockResolvedValue({
        id: 'user-1',
        phone: '+91123',
        refresh_token_hash: tokenHash,
        refresh_token_expires_at: new Date(Date.now() + 60_000),
      });

      const result = await service.verifyRefreshToken('user-1', rawRefreshToken);
      expect(result).toEqual(expect.objectContaining({ id: 'user-1' }));
    });
  });

  describe('revokeRefreshToken', () => {
    it('clears the refresh token hash/expiry on the profile', async () => {
      await service.revokeRefreshToken('user-1');
      expect(profiles.update).toHaveBeenCalledWith('user-1', {
        refresh_token_hash: null,
        refresh_token_expires_at: null,
      });
    });
  });
});
