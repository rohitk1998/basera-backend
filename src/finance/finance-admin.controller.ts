import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { PaymentsReconciler } from '../payments/payments-reconciler.service';
import { AdjustmentService } from './adjustment.service';
import { CommissionAgreementsService } from './commission-agreements.service';
import { ApprovePayoutDto, CreateAgreementDto, DecisionDto, FailPayoutDto, MarkPaidDto, PageQueryDto, RequestAdjustmentDto, SettingDto, UpdateAgreementDto } from './finance.dto';
import { FinanceQueryService } from './finance-query.service';
import { PayoutService } from './payout.service';
import { PlatformSettingsService, WRITABLE_SETTINGS } from './platform-settings.service';
import { RefundService } from './refund.service';

const READ = { default: { ttl: 60_000, limit: 120 } };
const WRITE = { default: { ttl: 60_000, limit: 20 } };

@Controller('api/admin/finance')
@UseGuards(AdminGuard)
export class FinanceAdminController {
  constructor(
    private readonly query: FinanceQueryService,
    private readonly refunds: RefundService,
    private readonly payouts: PayoutService,
    private readonly adjustments: AdjustmentService,
    private readonly agreements: CommissionAgreementsService,
    private readonly settings: PlatformSettingsService,
    private readonly reconciler: PaymentsReconciler,
  ) {}

  @Throttle(READ) @Get('summary')
  summary(@Query() q: PageQueryDto) {
    return this.query.summary(q.from, q.to);
  }

  @Throttle(READ) @Get('payments')
  payments(@Query() q: PageQueryDto) {
    return this.query.listPayments({ ...q, page: q.page ?? 1, pageSize: q.pageSize ?? 25 });
  }

  @Throttle(READ) @Get('payments/:id')
  payment(@Param('id', ParseUUIDPipe) id: string) {
    return this.query.paymentDetail(id);
  }

  @Throttle(READ) @Get('bookings/:bookingId/ledger')
  ledger(@Param('bookingId', ParseUUIDPipe) bookingId: string) {
    return this.query.ledgerForBooking(bookingId);
  }

  @Throttle(READ) @Get('hosts/:hostId/balance')
  hostBalance(@Param('hostId', ParseUUIDPipe) hostId: string) {
    return this.query.hostBalance(hostId);
  }

  // ---- refunds
  @Throttle(READ) @Get('refunds')
  async listRefunds(@Query() q: PageQueryDto) {
    return { success: true, items: await this.query.listRefunds(q.status, q.page ?? 1, q.pageSize ?? 25) };
  }

  @Throttle(WRITE) @Post('refunds/:id/retry') @HttpCode(200)
  @ResponseMessage('Refund re-submitted.')
  async retryRefund(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return { success: true, refund: await this.refunds.retry(id, admin.userId) };
  }

  // ---- payouts
  @Throttle(READ) @Get('payouts')
  async listPayouts(@Query() q: PageQueryDto) {
    return { success: true, items: await this.query.listPayouts(q.status, q.hostId, q.page ?? 1, q.pageSize ?? 25) };
  }

  @Throttle(WRITE) @Post('payouts/:id/approve') @HttpCode(200)
  @ResponseMessage('Payout approved.')
  async approvePayout(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApprovePayoutDto, @CurrentUser() admin: AuthUser) {
    return { success: true, payout: await this.payouts.approve(id, admin.userId, dto.provider ?? 'manual') };
  }

  @Throttle(WRITE) @Post('payouts/:id/mark-paid') @HttpCode(200)
  @ResponseMessage('Payout marked as paid.')
  async markPaid(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkPaidDto, @CurrentUser() admin: AuthUser) {
    return { success: true, payout: await this.payouts.markPaid(id, admin.userId, dto.bankReference) };
  }

  @Throttle(WRITE) @Post('payouts/:id/fail') @HttpCode(200)
  @ResponseMessage('Payout marked as failed.')
  async failPayout(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FailPayoutDto, @CurrentUser() admin: AuthUser) {
    return { success: true, payout: await this.payouts.markFailed(id, admin.userId, dto.reason) };
  }

  @Throttle(WRITE) @Post('payouts/:id/requeue') @HttpCode(200)
  @ResponseMessage('Payout requeued.')
  async requeuePayout(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return { success: true, payout: await this.payouts.requeue(id, admin.userId) };
  }

  // ---- adjustments (two-person rule)
  @Throttle(READ) @Get('adjustments')
  async listAdjustments(@Query('state') state?: string) {
    return { success: true, items: await this.adjustments.list(state) };
  }

  @Throttle(WRITE) @Post('adjustments')
  @ResponseMessage('Adjustment requested; a second admin must approve it.')
  async requestAdjustment(@Body() dto: RequestAdjustmentDto, @CurrentUser() admin: AuthUser) {
    return { success: true, adjustment: await this.adjustments.request(admin.userId, dto) };
  }

  @Throttle(WRITE) @Post('adjustments/:id/approve') @HttpCode(200)
  @ResponseMessage('Adjustment approved and posted to the ledger.')
  async approveAdjustment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() admin: AuthUser) {
    return { success: true, adjustment: await this.adjustments.approve(id, admin.userId, dto.note) };
  }

  @Throttle(WRITE) @Post('adjustments/:id/reject') @HttpCode(200)
  @ResponseMessage('Adjustment rejected.')
  async rejectAdjustment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() admin: AuthUser) {
    return { success: true, adjustment: await this.adjustments.reject(id, admin.userId, dto.note) };
  }

  // ---- commission agreements
  @Throttle(READ) @Get('commission-agreements')
  async listAgreements(@Query('scope') scope?: string) {
    return { success: true, items: await this.agreements.list(scope) };
  }

  @Throttle(WRITE) @Post('commission-agreements')
  @ResponseMessage('Commission agreement created.')
  async createAgreement(@Body() dto: CreateAgreementDto, @CurrentUser() admin: AuthUser) {
    return { success: true, agreement: await this.agreements.create(admin.userId, dto) };
  }

  @Throttle(WRITE) @Patch('commission-agreements/:id')
  @ResponseMessage('Commission agreement updated.')
  async updateAgreement(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgreementDto, @CurrentUser() admin: AuthUser) {
    return { success: true, agreement: await this.agreements.update(admin.userId, id, dto) };
  }

  @Throttle(WRITE) @Delete('commission-agreements/:id')
  @ResponseMessage('Commission agreement deleted.')
  async deleteAgreement(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    await this.agreements.remove(admin.userId, id);
    return { success: true };
  }

  // ---- platform settings
  @Throttle(READ) @Get('settings')
  async getSettings() {
    return { success: true, settings: await this.settings.all() };
  }

  @Throttle(WRITE) @Put('settings/:key')
  @ResponseMessage('Setting saved.')
  async putSetting(@Param('key') key: string, @Body() dto: SettingDto, @CurrentUser() admin: AuthUser) {
    const valid = WRITABLE_SETTINGS[key];
    if (!valid) throw new BadRequestException(`Unknown setting "${key}".`);
    if (!valid(dto?.value)) throw new BadRequestException(`Invalid value for "${key}".`);
    await this.settings.set(key, dto.value, admin.userId);
    return { success: true, key, value: dto.value };
  }

  // ---- reports / ops
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) @Get('reports/settlement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="settlement-report.csv"')
  settlementCsv(@Query() q: PageQueryDto) {
    return this.query.settlementCsv(q.from, q.to);
  }

  @Throttle({ default: { ttl: 60_000, limit: 3 } }) @Post('reconcile') @HttpCode(200)
  @ResponseMessage('Reconcile run finished.')
  async reconcile() {
    return { success: true, summary: await this.reconciler.run() };
  }
}
