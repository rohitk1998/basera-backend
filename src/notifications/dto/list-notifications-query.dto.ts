import { IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @IsUUID()
  beforeId?: string;

  @IsOptional()
  @IsString()
  locale?: string;
}
