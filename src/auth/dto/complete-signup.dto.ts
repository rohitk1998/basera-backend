import { ArrayMinSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class CompleteSignupDto {
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  name: string;

  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Pick at least one language' })
  @IsString({ each: true })
  languages: string[];

  @IsOptional()
  @IsBoolean()
  isHost?: boolean = false;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsString()
  @MinLength(1)
  proofToken: string;
}
