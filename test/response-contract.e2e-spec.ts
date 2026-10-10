import request from 'supertest';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  INestApplication,
  Patch,
  Post,
  Put,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerException } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ResponseMessage } from '../src/common/decorators/response-message.decorator';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { ResponseMessageInterceptor } from '../src/common/interceptors/response-message.interceptor';

class SignupDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  email!: string;
  @IsString()
  @MinLength(3, { message: 'name must be at least 3 characters' })
  name!: string;
}

@Controller('t')
class TestController {
  @ResponseMessage('Item created.')
  @Post('plain')
  plain() {
    return { success: true, id: 7 };
  }

  @ResponseMessage('Item created.')
  @Post('no-success-flag')
  noSuccessFlag() {
    return { id: 8 };
  }

  @ResponseMessage('Nothing to return.')
  @Delete('void')
  remove() {
    return undefined;
  }

  @ResponseMessage((r) => (r.status === 'verified' ? 'Verified.' : (r.reason ?? 'Not verified.')))
  @Post('by-outcome')
  byOutcome(@Body() b: { ok: boolean }) {
    return b.ok ? { status: 'verified' } : { status: 'rejected', reason: 'The photo was blurry.' };
  }

  @ResponseMessage('Generic text that must NOT win.')
  @Put('own-message')
  ownMessage() {
    return { success: true, message: 'Handler wrote this.' };
  }

  @Patch('undeclared')
  undeclared() {
    return { success: true };
  }

  @ResponseMessage('A list.')
  @Post('array')
  array() {
    return [1, 2, 3];
  }

  @Get('read')
  read() {
    return { listings: [1, 2] };
  }

  @ResponseMessage('Signed up.')
  @Post('validate')
  validate(@Body() _dto: SignupDto) {
    return { success: true };
  }

  @Post('conflict')
  conflict() {
    throw new ConflictException('Your PAN is already verified.');
  }
  @Post('bad')
  bad() {
    throw new BadRequestException('Enter a valid IFSC code.');
  }
  @Post('unavailable')
  unavailable() {
    throw new ServiceUnavailableException('Verification service is temporarily unavailable. Please try again.');
  }
  @Post('throttled')
  throttled() {
    throw new ThrottlerException();
  }
  @Post('crash')
  crash() {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  }
}

describe('response contract (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [TestController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: ResponseMessageInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(async () => app.close());

  const http = () => request(app.getHttpServer());

  describe('successful creates, updates and deletes', () => {
    it('adds the declared message and keeps the data', async () => {
      const res = await http().post('/t/plain').expect(201);
      expect(res.body).toEqual({ success: true, message: 'Item created.', id: 7 });
    });

    it('puts success and message first, then the data', async () => {
      const res = await http().post('/t/plain').expect(201);
      expect(Object.keys(res.body)).toEqual(['success', 'message', 'id']);
    });

    it('adds success: true when the handler forgot it', async () => {
      const res = await http().post('/t/no-success-flag').expect(201);
      expect(res.body).toEqual({ success: true, message: 'Item created.', id: 8 });
    });

    it('answers a handler that returns nothing with a body, not an empty response', async () => {
      const res = await http().delete('/t/void').expect(200);
      expect(res.body).toEqual({ success: true, message: 'Nothing to return.' });
    });

    it('builds the message from the outcome (verified vs refused with its reason)', async () => {
      expect((await http().post('/t/by-outcome').send({ ok: true })).body.message).toBe('Verified.');
      expect((await http().post('/t/by-outcome').send({ ok: false })).body.message).toBe('The photo was blurry.');
    });

    it('keeps a message the handler wrote itself', async () => {
      const res = await http().put('/t/own-message').expect(200);
      expect(res.body.message).toBe('Handler wrote this.');
    });

    it('never ships without a message, even for a handler that forgot to declare one', async () => {
      const res = await http().patch('/t/undeclared').expect(200);
      expect(res.body).toMatchObject({ success: true });
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
    });

    it('leaves array bodies untouched', async () => {
      const res = await http().post('/t/array').expect(201);
      expect(res.body).toEqual([1, 2, 3]);
    });

    it('leaves reads (GET) exactly as they were', async () => {
      const res = await http().get('/t/read').expect(200);
      expect(res.body).toEqual({ listings: [1, 2] });
    });
  });

  describe('errors', () => {
    const shape = (body: any, status: number, message: string) =>
      expect(body).toMatchObject({ success: false, statusCode: status, message, error: message });

    it('409 conflict: real message in both message and error, not "Conflict"', async () => {
      const res = await http().post('/t/conflict').expect(409);
      shape(res.body, 409, 'Your PAN is already verified.');
    });

    it('400 bad request: real message in both fields, not "Bad Request"', async () => {
      const res = await http().post('/t/bad').expect(400);
      shape(res.body, 400, 'Enter a valid IFSC code.');
    });

    it('503: keeps our user-safe message', async () => {
      const res = await http().post('/t/unavailable').expect(503);
      shape(res.body, 503, 'Verification service is temporarily unavailable. Please try again.');
    });

    it('validation errors: one readable message, plus the list', async () => {
      const res = await http().post('/t/validate').send({ email: 'nope', name: 'Al' }).expect(400);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toContain('email must be a valid email address');
      expect(res.body.message).toContain('name must be at least 3 characters');
      expect(res.body.error).toBe(res.body.message);
      expect(res.body.errors).toEqual(['email must be a valid email address', 'name must be at least 3 characters']);
      expect(res.body.success).toBe(false);
    });

    it('rate limiting: a friendly message, not "ThrottlerException: Too Many Requests"', async () => {
      const res = await http().post('/t/throttled').expect(429);
      shape(res.body, 429, 'Too many requests. Please wait a moment and try again.');
    });

    it('an unexpected crash answers a generic 500 and leaks nothing', async () => {
      const res = await http().post('/t/crash').expect(500);
      shape(res.body, 500, 'Something went wrong. Please try again.');
      expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    });

    it('an unknown route answers a message too', async () => {
      const res = await http().post('/t/does-not-exist').expect(404);
      expect(res.body).toMatchObject({ success: false, statusCode: 404 });
      expect(typeof res.body.message).toBe('string');
    });

    it('a malformed JSON body answers a readable 400', async () => {
      const res = await http().post('/t/plain').set('Content-Type', 'application/json').send('{"broken":').expect(400);
      expect(res.body).toMatchObject({ success: false, statusCode: 400 });
      expect(typeof res.body.message).toBe('string');
    });
  });
});
