import { Module } from '@nestjs/common';
import { CashfreeService } from './cashfree.service';

@Module({
  providers: [CashfreeService],
  exports: [CashfreeService],
})
export class CashfreeModule {}
