import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { AdminService } from './admin.service';

@Controller('api/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('audits')
  getAudits() {
    return this.adminService.getAudits();
  }

  @Get('properties')
  getProperties(@Query('status') status?: string, @Query('q') q?: string) {
    return this.adminService.getProperties(status, q);
  }

  @Patch('properties/:id')
  reviewProperty(@Param('id') id: string, @CurrentUser() admin: AuthUser, @Body() body: unknown) {
    return this.adminService.reviewProperty(id, admin.userId, body);
  }

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('users')
  getUsers(@Query('role') role?: string, @Query('q') q?: string) {
    return this.adminService.getUsers(role, q);
  }

  @Patch('users/:id')
  setIsHost(@Param('id') id: string, @Body('isHost') isHost: unknown) {
    return this.adminService.setIsHost(id, isHost as boolean);
  }

  @Get('payments')
  getPayments(@Query('status') status?: string) {
    return this.adminService.getPayments(status);
  }

  @Get('disputes')
  getDisputes() {
    return this.adminService.getDisputes();
  }

  @Patch('disputes/:bookingId')
  resolveDispute(
    @Param('bookingId') bookingId: string,
    @CurrentUser() admin: AuthUser,
    @Body('resolution') resolution: unknown,
  ) {
    return this.adminService.resolveDispute(bookingId, admin.userId, resolution);
  }

  @Get('subscriptions')
  getSubscriptions() {
    return this.adminService.getSubscriptions();
  }
}
