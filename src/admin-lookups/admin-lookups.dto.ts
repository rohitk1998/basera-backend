import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class ConsentQueryDto {
  @IsIn(['lead', 'user', 'phone']) subjectType: 'lead' | 'user' | 'phone';
  @IsString() @MinLength(1) @MaxLength(64) subjectId: string;
  @IsOptional() @IsIn(['email', 'push', 'whatsapp', 'sms']) channel?: 'email' | 'push' | 'whatsapp' | 'sms';
}

export class UserLookupDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((v) => v.trim()).filter(Boolean) : value))
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  ids: string[];
}
