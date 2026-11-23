import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { BookingsModule } from '../bookings/bookings.module';
import { CashfreeModule } from '../payments/cashfree.module';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsReconciler } from '../payments/payments-reconciler.service';
import { PaymentsReconcileScheduler } from '../payments/payments-reconcile.scheduler';
import { FinanceAdminController } from './finance-admin.controller';
import { FinanceModule } from './finance.module';
import { FinanceQueryService } from './finance-query.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), AuthModule, FinanceModule, PaymentsModule, CashfreeModule, BookingsModule],
  controllers: [FinanceAdminController],
  providers: [FinanceQueryService, PaymentsReconciler, PaymentsReconcileScheduler],
})
export class FinanceAdminModule {}
