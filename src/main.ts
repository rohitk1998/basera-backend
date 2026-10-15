import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // The web app reaches this API through a Next.js rewrite, so every request's
  // socket address is the Next server. Without trusting the forwarded client IP
  // the rate limiter puts all visitors in one shared bucket. 'loopback' trusts
  // X-Forwarded-For only from a proxy on this host; set TRUST_PROXY (hop count,
  // CIDR list, ...) when the proxy lives elsewhere.
  app.set('trust proxy', config.get<string>('TRUST_PROXY') ?? 'loopback');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', '').split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
  });

  await app.listen(config.get<number>('PORT') ?? 4000);
}
bootstrap();
