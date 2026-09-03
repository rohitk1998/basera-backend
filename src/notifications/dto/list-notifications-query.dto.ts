import { IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @IsUUID()
  beforeId?: string;

  // The viewer's current NEXT_LOCALE cookie, forwarded by the web app —
  // reflects what's on screen right now, not a possibly-stale synced
  // preferred_locale value.
  @IsOptional()
  @IsString()
  locale?: string;
}
