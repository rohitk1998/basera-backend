/**
 * Runs the attractions import from the command line and exits:
 *
 *   npm run import:attractions                 # all 12 districts
 *   npm run import:attractions -- Kullu        # one district
 *
 * Needs the normal backend .env (Wikidata needs no key). Everything it adds
 * is a draft: publish from the admin console's Explore places tab.
 */
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
