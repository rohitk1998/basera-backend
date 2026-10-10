import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { DisputeOfferDto } from '../bookings/dto/dispute-offer.dto';
import { AdminService } from './admin.service';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

@Controller('api/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('audits')
  getAudits() {
    return this.adminService.getAudits();
  }

  @Get('properties')
  getProperties(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = page ? Number.parseInt(page, 10) || 1 : 1;
    const parsedPageSize = pageSize ? Math.min(Number.parseInt(pageSize, 10) || 20, 100) : 20;
    return this.adminService.getProperties(status, q, parsedPage, parsedPageSize);
  }

  @Get('properties/:id/walkthrough-url')
  getWalkthroughVideoUrl(@Param('id') id: string) {
    return this.adminService.getWalkthroughVideoUrl(id);
  }

  @ResponseMessage((_r, req) => ({ live: 'Listing approved and published.', changes_needed: 'Changes requested from the host.', rejected: 'Listing rejected.', paused: 'Listing paused.', in_review: 'Listing moved back to review.' } as Record<string, string>)[req.body?.status] ?? (req.body?.markVisitPassed ? 'Site visit marked as passed.' : 'Listing updated.'))
  @Patch('properties/:id')
  reviewProperty(@Param('id') id: string, @CurrentUser() admin: AuthUser, @Body() body: unknown) {
    return this.adminService.reviewProperty(id, admin.userId, body);
  }

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('users')
  getUsers(
    @Query('role') role?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = page ? Number.parseInt(page, 10) || 1 : 1;
    const parsedPageSize = pageSize ? Math.min(Number.parseInt(pageSize, 10) || 20, 100) : 20;
    return this.adminService.getUsers(role, q, parsedPage, parsedPageSize);
  }

  @ResponseMessage((_r, req) => (req.body?.isHost ? 'User is now a host.' : 'Host access removed from this user.'))
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

  // Money-moving: validated the same way bookings' own dispute-offer
  // endpoint is (DisputeOfferDto), instead of the previous unknown-typed
  // body left to admin.service.ts's own hand-rolled checks.
  @ResponseMessage('Dispute resolved.')
  @Patch('disputes/:bookingId')
  resolveDispute(
    @Param('bookingId') bookingId: string,
    @CurrentUser() admin: AuthUser,
    @Body() dto: DisputeOfferDto,
  ) {
    return this.adminService.resolveDispute(bookingId, admin.userId, dto.amountToGuest, dto.message);
  }

  @ResponseMessage('Appeal decided.')
  @Patch('disputes/:bookingId/appeal')
  resolveAppeal(
    @Param('bookingId') bookingId: string,
    @CurrentUser() admin: AuthUser,
    @Body() dto: DisputeOfferDto,
  ) {
    return this.adminService.resolveAppeal(bookingId, admin.userId, dto.amountToGuest, dto.message);
  }

  @Get('users/:id/verification')
  getUserVerificationSummary(@Param('id') id: string) {
    return this.adminService.getUserVerificationSummary(id);
  }

  @Get('verification/:id')
  getVerificationRequestDetail(@Param('id') id: string) {
    return this.adminService.getVerificationRequestDetail(id);
  }

  @ResponseMessage((_r, req) => (req.body?.decision === 'approve' ? 'Verification approved.' : 'Verification rejected.'))
  @Post('verification/:id/review')
  reviewVerificationRequest(@Param('id') id: string, @CurrentUser() admin: AuthUser, @Body() body: unknown) {
    return this.adminService.reviewVerificationRequest(id, admin.userId, body);
  }

  @Get('verification/:id/document-url')
  getVerificationDocumentUrl(@Param('id') id: string) {
    return this.adminService.getVerificationDocumentUrl(id);
  }
}
