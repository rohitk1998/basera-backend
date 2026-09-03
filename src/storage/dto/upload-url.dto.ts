import { IsOptional, IsString, MinLength } from 'class-validator';

export class UploadUrlDto {
  @IsString()
  @MinLength(1)
  fileName: string;

  // Accepted for parity with the original body shape; unused server-side —
  // the signed URL's contentType is set by the client's PUT, not here.
  @IsOptional()
  @IsString()
  fileType?: string;

  @IsOptional()
  @IsString()
  bucket?: string;
}
