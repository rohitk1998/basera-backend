import { Module } from '@nestjs/common';
import { CashfreeModule } from '../payments/cashfree.module';
import { AdjustmentService } from './adjustment.service';
import { CommissionAgreementsService } from './commission-agreements.service';
import { CommissionService } from './commission.service';
import { FinanceAuditService } from './finance-audit.service';
import { FinanceFlowService } from './finance-flow.service';
import { LedgerService } from './ledger.service';
import { PayoutService } from './payout.service';
import { PlatformSettingsService } from './platform-settings.service';
import { RefundService } from './refund.service';

/** Core finance services (no controllers, no dependency on bookings) so PaymentsModule/BookingsModule can import it. */
@Module({
  imports: [CashfreeModule],
  providers: [PlatformSettingsService, FinanceAuditService, CommissionService, CommissionAgreementsService, LedgerService, RefundService, PayoutService, AdjustmentService, FinanceFlowService],
  exports: [PlatformSettingsService, FinanceAuditService, CommissionService, CommissionAgreementsService, LedgerService, RefundService, PayoutService, AdjustmentService, FinanceFlowService],
})
export class FinanceModule {}
