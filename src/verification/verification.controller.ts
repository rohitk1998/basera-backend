import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { VerificationDocumentFile } from '../storage/storage.service';
import { SubmitBankDto } from './dto/submit-bank.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { SubmitLegalDto } from './dto/submit-legal.dto';
import { BankDetailsInput, IdentityDocumentSubtype, VerificationService } from './verification.service';

interface UploadedMulterFile {
  buffer?: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

const VERIFICATION_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024; // 8MB, matches StorageService validation

async function validateDto<T extends object>(cls: new () => T, plain: Record<string, unknown>): Promise<T> {
  const instance = plainToInstance(cls, plain);
  const errors = await validate(instance, { whitelist: true });
  if (errors.length > 0) {
    const message = errors
      .flatMap((e) => Object.values(e.constraints ?? {}))
      .join(' ');
    throw new BadRequestException(message || 'Invalid request.');
  }
  return instance;
}

function toVerificationDocumentFile(file?: UploadedMulterFile): VerificationDocumentFile | undefined {
  if (!file) return undefined;
  if (!file.buffer) {
    throw new BadRequestException('No file provided.');
  }
  return {
    buffer: file.buffer,
    mimetype: file.mimetype,
    size: file.size,
    originalname: file.originalname,
  };
}

function requireFile(file?: UploadedMulterFile): VerificationDocumentFile {
  const converted = toVerificationDocumentFile(file);
  if (!converted) {
    throw new BadRequestException('No file provided.');
  }
  return converted;
}

/**
 * User-facing verification submission API (identity / pan / bank / legal). Every
 * route requires a logged-in user; a user can only ever act on their own
 * requests — there is no way to pass another user's id in, requests are
 * always scoped to @CurrentUser().
 */
@Controller('api/verification')
@UseGuards(AuthGuard)
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('status')
  async getStatus(@CurrentUser() user: AuthUser) {
    const status = await this.verification.getMyStatus(user.userId);
    return { success: true, ...status };
  }

  @Post('identity')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitIdentity(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const dto = await validateDto(SubmitIdentityDto, body);
    const result = await this.verification.submitIdentity(
      user.userId,
      dto.documentSubtype as IdentityDocumentSubtype,
      requireFile(file),
    );
    return { success: true, identity: result };
  }

  @Post('identity/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitIdentity(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const dto = await validateDto(SubmitIdentityDto, body);
    const result = await this.verification.resubmitIdentity(
      user.userId,
      dto.documentSubtype as IdentityDocumentSubtype,
      requireFile(file),
    );
    return { success: true, identity: result };
  }

  @Post('pan')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitPan(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.submitPan(user.userId, requireFile(file));
    return { success: true, pan: result };
  }

  @Post('pan/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitPan(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.resubmitPan(user.userId, requireFile(file));
    return { success: true, pan: result };
  }

  @Post('bank')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitBank(
    @CurrentUser() user: AuthUser,
    @Body('bankDetails') bankDetailsJson: string,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const bankDetails = await this.parseBankDetails(bankDetailsJson);
    const result = await this.verification.submitBank(user.userId, bankDetails, toVerificationDocumentFile(file));
    return { success: true, bank: result };
  }

  @Post('bank/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitBank(
    @CurrentUser() user: AuthUser,
    @Body('bankDetails') bankDetailsJson: string,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const bankDetails = await this.parseBankDetails(bankDetailsJson);
    const result = await this.verification.resubmitBank(user.userId, bankDetails, toVerificationDocumentFile(file));
    return { success: true, bank: result };
  }

  @Post('selfie')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitSelfie(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.submitSelfie(user.userId, requireFile(file));
    return { success: true, selfie: result };
  }

  @Post('selfie/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitSelfie(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.resubmitSelfie(user.userId, requireFile(file));
    return { success: true, selfie: result };
  }

  @Post('legal')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitLegal(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const dto = await validateDto(SubmitLegalDto, body);
    const result = await this.verification.submitLegal(user.userId, dto.registrationNumber, requireFile(file));
    return { success: true, legal: result };
  }

  @Post('legal/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitLegal(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const dto = await validateDto(SubmitLegalDto, body);
    const result = await this.verification.resubmitLegal(user.userId, dto.registrationNumber, requireFile(file));
    return { success: true, legal: result };
  }

  @Get(':id/document-url')
  async getDocumentUrl(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.verification.getMyDocumentUrl(user.userId, id);
    return { success: true, ...result };
  }

  // bankDetails rides as a JSON-stringified multipart field alongside the
  // optional file, same combining pattern host-listings.controller.ts uses
  // for `rooms` in uploadPhotos — a plain @Body() DTO cannot bind directly
  // to a multipart request's non-file fields.
  private async parseBankDetails(bankDetailsJson: string): Promise<BankDetailsInput> {
    if (!bankDetailsJson) {
      throw new BadRequestException('bankDetails is required.');
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bankDetailsJson);
    } catch {
      throw new BadRequestException('bankDetails must be valid JSON.');
    }
    const dto = await validateDto(SubmitBankDto, parsed);
    return {
      accountHolderName: dto.accountHolderName,
      bankName: dto.bankName,
      accountNumber: dto.accountNumber,
      ifsc: dto.ifsc,
    };
  }
}
