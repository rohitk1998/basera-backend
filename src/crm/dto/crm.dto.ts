import { Type } from 'class-transformer';
import {
  Equals, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { CONTACT_STATES, LEAD_SOURCES, OUTREACH_CHANNELS } from '../crm.types';

export class CreateLeadDto {
  @IsOptional() @IsUUID() listingId?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(200) propertyHint?: string;
  @IsIn(LEAD_SOURCES as unknown as string[]) source: (typeof LEAD_SOURCES)[number];
  @IsOptional() @IsUUID() ownerStaffId?: string;
  @IsOptional() @IsISO8601() nextActionAt?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateLeadDto {
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(200) propertyHint?: string;
  @IsOptional() @IsISO8601() nextActionAt?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  /** CONVERTED is rejected here: only a claim approval converts a lead. */
  @IsOptional() @IsIn(CONTACT_STATES as unknown as string[]) contactState?: (typeof CONTACT_STATES)[number];
}

export class AssignLeadDto {
  @IsOptional() @IsUUID() staffId?: string | null;
}

export class ListLeadsQueryDto {
  @IsOptional() @IsIn(CONTACT_STATES as unknown as string[]) state?: string;
  @IsOptional() @IsUUID() assignee?: string;
  @IsOptional() @IsIn(LEAD_SOURCES as unknown as string[]) source?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() overdue?: boolean;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export const ATTEMPT_OUTCOMES = ['no_answer', 'connected', 'call_back', 'interested', 'not_interested', 'wrong_number', 'do_not_contact'] as const;

export class LogAttemptDto {
  @IsIn(['call', 'sms', 'visit', 'email', 'whatsapp']) channel: 'call' | 'sms' | 'visit' | 'email' | 'whatsapp';
  @IsOptional() @IsIn(['outbound', 'inbound']) direction?: 'outbound' | 'inbound';
  @IsIn(ATTEMPT_OUTCOMES as unknown as string[]) outcome: (typeof ATTEMPT_OUTCOMES)[number];
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsISO8601() nextActionAt?: string;
}

export class ScheduleTaskDto {
  @IsISO8601() dueAt: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsIn(['call', 'whatsapp', 'email', 'visit', 'follow_up']) kind?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class CompleteTaskDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsISO8601() nextActionAt?: string;
}

export class RecordConsentDto {
  @IsIn(['email', 'whatsapp', 'sms']) channel: 'email' | 'whatsapp' | 'sms';
  @IsBoolean() granted: boolean;
  /** Where the consent was captured, e.g. "verbal call 22 Nov", "signed form". Required: it is the audit trail. */
  @IsString() @Length(3, 300) evidence: string;
}

export class CreateInvitationDto {
  @IsOptional() @IsIn(['auto', 'email', 'whatsapp', 'manual']) channel?: 'auto' | 'email' | 'whatsapp' | 'manual';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) ttlDays?: number;
}

export class HostResponseDto {
  @IsIn(['interested', 'declined', 'do_not_contact', 'call_back']) response: 'interested' | 'declined' | 'do_not_contact' | 'call_back';
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsISO8601() nextActionAt?: string;
}

export class AnalyticsQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class MyTasksQueryDto {
  @IsOptional() @IsIn(['today', 'overdue', 'all']) scope?: 'today' | 'overdue' | 'all';
}

export class VerifyTokenQueryDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token: string;
}

export class OptOutDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token: string;
}

export class HostRegistrationDto {
  @IsString() @Length(2, 120) name: string;
  @IsString() @Length(8, 20) phone: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(200) propertyName?: string;
  @IsOptional() @IsString() @MaxLength(1000) message?: string;
  /** Must be explicitly true: the host agrees RhenBasera may contact them about hosting. */
  @IsBoolean() @Equals(true) consentToContact: boolean;
  /** Honeypot: hidden field real users leave empty. Bots that fill it get a silent success. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}
