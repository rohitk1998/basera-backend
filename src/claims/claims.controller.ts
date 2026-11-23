import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { EVIDENCE_MAX_BYTES } from './claims.constants';
import {
  AdminClaimsQueryDto, CandidateSearchDto, DecisionNoteDto, EvidenceUploadDto, OptionalNoteDto, StartClaimDto, UpdateClaimDto,
} from './claims.dto';
import { ClaimsService, type UploadedEvidenceFile } from './claims.service';

const uuid = new ParseUUIDPipe({ errorHttpStatusCode: 404 });

@Controller('api/claims')
@UseGuards(AuthGuard)
export class ClaimsController {
  constructor(private readonly service: ClaimsService) {}

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('candidates')
  candidates(@Query() q: CandidateSearchDto) {
    return this.service.searchCandidates(q.destination, q.q);
  }

  @Get()
  mine(@CurrentUser() user: AuthUser) {
    return this.service.listMine(user.userId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Claim started.')
  @Post()
  start(@CurrentUser() user: AuthUser, @Body() dto: StartClaimDto) {
    return this.service.start(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.service.getMine(user.userId, id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('Draft saved.')
  @Patch(':id')
  save(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Body() dto: UpdateClaimDto) {
    return this.service.saveDraft(user.userId, id, dto);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Evidence uploaded.')
  @Post(':id/evidence')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: EVIDENCE_MAX_BYTES, files: 1 } }))
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: EvidenceUploadDto,
    @UploadedFile() file: UploadedEvidenceFile | undefined,
  ) {
    return this.service.uploadEvidence(user.userId, id, dto.kind, file);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ResponseMessage('Evidence removed.')
  @Delete(':id/evidence/:evidenceId')
  removeEvidence(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string, @Param('evidenceId', uuid) evidenceId: string) {
    return this.service.deleteEvidence(user.userId, id, evidenceId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ResponseMessage('Claim submitted for review.')
  @Post(':id/submit')
  submit(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.service.submit(user.userId, id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Claim withdrawn.')
  @Post(':id/withdraw')
  withdraw(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.service.withdraw(user.userId, id);
  }
}

@Controller('api/admin/claims')
@UseGuards(AdminGuard)
export class AdminClaimsController {
  constructor(private readonly service: ClaimsService) {}

  @Get()
  list(@Query() q: AdminClaimsQueryDto) {
    return this.service.adminList(q);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string) {
    return this.service.adminGet(id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Get(':id/evidence/:evidenceId/url')
  evidenceUrl(@CurrentUser() admin: AuthUser, @Param('id', uuid) id: string, @Param('evidenceId', uuid) evidenceId: string) {
    return this.service.adminEvidenceUrl(admin.userId, id, evidenceId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ResponseMessage('Review started.')
  @Post(':id/start-review')
  startReview(@CurrentUser() admin: AuthUser, @Param('id', uuid) id: string) {
    return this.service.startReview(admin.userId, id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ResponseMessage('More information requested.')
  @Post(':id/request-info')
  requestInfo(@CurrentUser() admin: AuthUser, @Param('id', uuid) id: string, @Body() dto: DecisionNoteDto) {
    return this.service.requestInfo(admin.userId, id, dto.note);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('Claim approved. The property is now a draft listing owned by the claimant.')
  @Post(':id/approve')
  approve(@CurrentUser() admin: AuthUser, @Param('id', uuid) id: string, @Body() dto: OptionalNoteDto) {
    return this.service.approve(admin.userId, id, dto.note);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ResponseMessage('Claim rejected.')
  @Post(':id/reject')
  reject(@CurrentUser() admin: AuthUser, @Param('id', uuid) id: string, @Body() dto: DecisionNoteDto) {
    return this.service.reject(admin.userId, id, dto.note);
  }
}
