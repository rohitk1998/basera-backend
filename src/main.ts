import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);
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
