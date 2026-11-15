import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { ResponseMessage } from '../common/decorators/response-message.decorator';
import { MAX_IMAGE_BYTES, REQUIRED_FRAMES } from './host-verification.constants';
import { ConsentDto } from './host-verification.dto';
import { HostVerificationService, type UploadedImage } from './host-verification.service';

type MulterFile = { buffer: Buffer; size: number };
type SubmitFiles = { document?: MulterFile[]; frames?: MulterFile[] };

const parseChallenges = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const toImage = (f: MulterFile): UploadedImage => ({ buffer: f.buffer, size: f.size });

@Controller('api/host-verification')
@UseGuards(AuthGuard)
export class HostVerificationController {
  constructor(private readonly service: HostVerificationService) {}

  @Get('status')
  async status(@CurrentUser() user: AuthUser) {
    return { success: true, ...(await this.service.getMyStatus(user.userId)) };
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ResponseMessage('Consent recorded.')
  @Post('consent')
  consent(@CurrentUser() user: AuthUser, @Body() dto: ConsentDto) {
    return this.service.startConsent(user.userId, dto.version);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ResponseMessage('Submitted for review.')
  @Post(':id/submit')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'document', maxCount: 1 },
        { name: 'frames', maxCount: REQUIRED_FRAMES },
      ],
      { limits: { fileSize: MAX_IMAGE_BYTES, files: REQUIRED_FRAMES + 1 } },
    ),
  )
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() body: { docType?: string; idNumber?: string; challenges?: unknown },
    @UploadedFiles() files: SubmitFiles,
  ) {
    if (typeof body.docType !== 'string') throw new BadRequestException('Choose the type of ID.');
    return this.service.submit(user.userId, id, {
      docType: body.docType,
      idNumber: typeof body.idNumber === 'string' ? body.idNumber : undefined,
      challenges: parseChallenges(body.challenges),
      document: files?.document?.[0] ? toImage(files.document[0]) : undefined,
      frames: (files?.frames ?? []).map(toImage),
    });
  }
}
