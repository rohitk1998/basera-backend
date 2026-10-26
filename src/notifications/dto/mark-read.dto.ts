import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class MarkReadDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}
