import { IsOptional, IsString, MinLength } from 'class-validator';

export class UploadUrlDto {
  @IsString()
  @MinLength(1)
  fileName: string;

  @IsOptional()
  @IsString()
  fileType?: string;

  @IsOptional()
  @IsString()
  bucket?: string;
}
