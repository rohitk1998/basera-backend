import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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

  @Get('disputes/:bookingId')
  getDisputeCase(@Param('bookingId') bookingId: string, @CurrentUser() admin: AuthUser) {
    return this.adminService.getDisputeCase(bookingId, admin.userId);
  }

  @Patch('disputes/:bookingId')
  resolveDispute(
    @Param('bookingId') bookingId: string,
    @CurrentUser() admin: AuthUser,
    @Body('amountToGuest') amountToGuest: unknown,
    @Body('message') message: unknown,
  ) {
    return this.adminService.resolveDispute(bookingId, admin.userId, amountToGuest, message);
  }

  @Patch('disputes/:bookingId/appeal')
  resolveAppeal(
    @Param('bookingId') bookingId: string,
    @CurrentUser() admin: AuthUser,
    @Body('amountToGuest') amountToGuest: unknown,
    @Body('message') message: unknown,
  ) {
    return this.adminService.resolveAppeal(bookingId, admin.userId, amountToGuest, message);
  }

  @Get('subscriptions')
  getSubscriptions() {
    return this.adminService.getSubscriptions();
  }

  @Get('users/:id/verification')
  getUserVerificationSummary(@Param('id') id: string) {
    return this.adminService.getUserVerificationSummary(id);
  }

  @Get('verification/:id')
  getVerificationRequestDetail(@Param('id') id: string) {
    return this.adminService.getVerificationRequestDetail(id);
  }

  @Post('verification/:id/review')
  reviewVerificationRequest(@Param('id') id: string, @CurrentUser() admin: AuthUser, @Body() body: unknown) {
    return this.adminService.reviewVerificationRequest(id, admin.userId, body);
  }

  @Get('verification/:id/document-url')
  getVerificationDocumentUrl(@Param('id') id: string) {
    return this.adminService.getVerificationDocumentUrl(id);
  }
}
