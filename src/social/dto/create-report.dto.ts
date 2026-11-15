import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export const REPORT_TARGET_TYPES = [
  'user',
  'story',
  'message',
  'meetup',
] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export class CreateReportDto {
  @IsIn(REPORT_TARGET_TYPES)
  targetType: ReportTargetType;

  @IsUUID()
  targetId: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
