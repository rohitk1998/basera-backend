import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from './payments.service';

@UseGuards(AuthGuard)
@Controller('api/transactions')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  async getTransactions(@CurrentUser() user: AuthUser, @Query('role') role?: 'guest' | 'host') {
    return this.paymentsService.listTransactions(user.userId, role);
  }
}
