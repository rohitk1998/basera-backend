import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { HP_DISTRICTS, type HpDistrict } from '../listings/hp-locations';
import { AttractionsImportService } from './attractions-import.service';

async function main() {
  const [, , districtArg] = process.argv;
  let district: HpDistrict | undefined;
  if (districtArg) {
    district = HP_DISTRICTS.find(
      (d) => d.toLowerCase() === districtArg.toLowerCase(),
    );
    if (!district) {
      console.error(
        `Unknown district "${districtArg}". Use one of: ${HP_DISTRICTS.join(', ')}`,
      );
      process.exit(1);
    }
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const status = await app.get(AttractionsImportService).runNow({ district });
    process.exitCode = status.error ? 1 : 0;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
