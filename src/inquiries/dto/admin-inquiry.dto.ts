import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { INQUIRY_STATES } from '../inquiry.types';

export class AssignInquiryDto {
  /** null un-assigns. */
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  assigneeId: string | null;
}

export class InquiryActionDto {
  /** Optional internal note, saved as an internal message with the action. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(4000)
  note?: string;
}

export class ListInquiriesQueryDto {
  @IsOptional() @IsIn(INQUIRY_STATES) state?: string;
  @IsOptional() @IsString() @MaxLength(40) assignee?: string; // uuid | 'unassigned'
  @IsOptional() @IsIn(['true', 'false']) overdue?: string;
  @IsOptional() @IsString() @MaxLength(120) destination?: string;
  @IsOptional() @IsString() @MaxLength(120) q?: string;
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  @IsOptional() @IsString() @MaxLength(4) pageSize?: string;
}
