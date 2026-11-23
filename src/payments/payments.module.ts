import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentEntity } from '../entities';
import { FinanceModule } from '../finance/finance.module';
import { CashfreeModule } from './cashfree.module';
import { PaymentsService } from './payments.service';

import { PaymentsController } from './payments.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PaymentEntity]), FinanceModule, CashfreeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
