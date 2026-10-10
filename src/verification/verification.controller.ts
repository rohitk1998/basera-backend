import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { VerificationDocumentFile } from '../storage/storage.service';
import { SubmitBankDto } from './dto/submit-bank.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { VerifyBankDto } from './dto/verify-bank.dto';
import { VerifyPanDto } from './dto/verify-pan.dto';
import { VerifyUpiDto } from './dto/verify-upi.dto';
import { BankDetailsInput, IdentityDocumentSubtype, VerificationService } from './verification.service';
import { ResponseMessage } from '../common/decorators/response-message.decorator';

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

/** The Aadhaar card has two sides; both are required. Checked here (400) so a
 *  malformed request never reaches storage or the database. */
function assertBackFile(fileBack: VerificationDocumentFile | undefined): asserts fileBack is VerificationDocumentFile {
  if (!fileBack) {
    throw new BadRequestException('Both sides of your Aadhaar card are required — the back side is missing.');
  }
}

/** 'pending' means an admin has it (AADHAAR_VERIFICATION_MODE=admin); otherwise Cashfree already decided. */
function identityMessage(r: { identity?: { status?: string; rejectionReason?: string | null } }): string {
  if (r.identity?.status === 'verified') return 'Aadhaar verified.';
  if (r.identity?.status === 'pending') return 'Aadhaar submitted for review.';
  return r.identity?.rejectionReason ?? 'Aadhaar could not be verified.';
}

/**
 * User-facing verification submission API (identity / pan / bank / selfie). Every
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

  @ResponseMessage(identityMessage)
  @Post('identity')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'fileBack', maxCount: 1 },
      ],
      { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } },
    ),
  )
  async submitIdentity(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: { file?: UploadedMulterFile[]; fileBack?: UploadedMulterFile[] },
  ) {
    const dto = await validateDto(SubmitIdentityDto, body);
    const file = requireFile(files?.file?.[0]);
    const fileBack = toVerificationDocumentFile(files?.fileBack?.[0]);
    assertBackFile(fileBack);
    const result = await this.verification.submitIdentity(
      user.userId,
      dto.documentSubtype as IdentityDocumentSubtype,
      file,
      fileBack,
    );
    return { success: true, identity: result };
  }

  @ResponseMessage(identityMessage)
  @Post('identity/resubmit')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'fileBack', maxCount: 1 },
      ],
      { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } },
    ),
  )
  async resubmitIdentity(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: { file?: UploadedMulterFile[]; fileBack?: UploadedMulterFile[] },
  ) {
    const dto = await validateDto(SubmitIdentityDto, body);
    const file = requireFile(files?.file?.[0]);
    const fileBack = toVerificationDocumentFile(files?.fileBack?.[0]);
    assertBackFile(fileBack);
    const result = await this.verification.resubmitIdentity(
      user.userId,
      dto.documentSubtype as IdentityDocumentSubtype,
      file,
      fileBack,
    );
    return { success: true, identity: result };
  }

  @ResponseMessage('PAN submitted for review.')
  @Post('pan')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitPan(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.submitPan(user.userId, requireFile(file));
    return { success: true, pan: result };
  }

  @ResponseMessage('PAN submitted for review.')
  @Post('pan/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitPan(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.resubmitPan(user.userId, requireFile(file));
    return { success: true, pan: result };
  }

  @ResponseMessage('Bank details submitted for review.')
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

  @ResponseMessage('Bank details submitted for review.')
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

  // Bank is the one verification type a host can change even once already
  // verified — see VerificationService.changeBank's doc comment for why.
  @ResponseMessage('Bank account change submitted for review.')
  @Post('bank/change')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async changeBank(
    @CurrentUser() user: AuthUser,
    @Body('bankDetails') bankDetailsJson: string,
    @UploadedFile() file?: UploadedMulterFile,
  ) {
    const bankDetails = await this.parseBankDetails(bankDetailsJson);
    const result = await this.verification.changeBank(user.userId, bankDetails, toVerificationDocumentFile(file));
    return { success: true, bank: result };
  }

  @ResponseMessage('Selfie submitted for review.')
  @Post('selfie')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async submitSelfie(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.submitSelfie(user.userId, requireFile(file));
    return { success: true, selfie: result };
  }

  @ResponseMessage('Selfie submitted for review.')
  @Post('selfie/resubmit')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async resubmitSelfie(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.resubmitSelfie(user.userId, requireFile(file));
    return { success: true, selfie: result };
  }

  // ── Automated checks (Cashfree) — answered immediately, no admin review ──

  @ResponseMessage((r) => (r.pan?.status === 'verified' ? 'PAN verified.' : (r.pan?.rejectionReason ?? 'PAN could not be verified.')))
  @Post('pan/verify')
  async verifyPan(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    const dto = await validateDto(VerifyPanDto, { ...body, pan: String(body?.pan ?? '').toUpperCase() });
    const result = await this.verification.verifyPanNumber(user.userId, dto.pan, dto.name);
    return { success: true, pan: result };
  }

  @ResponseMessage((r) => (r.bank?.status === 'verified' ? 'Bank account verified.' : (r.bank?.rejectionReason ?? 'Bank account could not be verified.')))
  @Post('bank/verify')
  async verifyBank(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    const dto = await validateDto(VerifyBankDto, { ...body, ifsc: String(body?.ifsc ?? '').toUpperCase() });
    const result = await this.verification.verifyBankAccount(user.userId, {
      accountHolderName: dto.accountHolderName,
      bankName: typeof body?.bankName === 'string' ? body.bankName : '',
      accountNumber: dto.accountNumber,
      ifsc: dto.ifsc,
    });
    return { success: true, bank: result };
  }

  @ResponseMessage('UPI ID verified.')
  @Post('upi/verify')
  async verifyUpi(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    const dto = await validateDto(VerifyUpiDto, body);
    const result = await this.verification.verifyUpiId(user.userId, dto.vpa);
    return { success: true, upi: result };
  }

  @ResponseMessage((r) => (r.selfie?.status === 'verified' ? 'Selfie verified.' : (r.selfie?.rejectionReason ?? 'Selfie could not be verified.')))
  @Post('selfie/verify')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VERIFICATION_DOCUMENT_MAX_BYTES } }))
  async verifySelfie(@CurrentUser() user: AuthUser, @UploadedFile() file?: UploadedMulterFile) {
    const result = await this.verification.verifySelfieLiveness(user.userId, requireFile(file));
    return { success: true, selfie: result };
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
