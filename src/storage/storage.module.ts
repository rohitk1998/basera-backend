import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [StorageController],
  providers: [StorageService],
  // Exported so other feature modules (e.g. AdminModule's verification
  // review routes) can request signed download URLs for private documents
  // without duplicating a SupabaseProvider-backed service.
  exports: [StorageService],
})
export class StorageModule {}
