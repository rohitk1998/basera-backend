import { ArrayMinSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

// Ported from web/lib/validations.ts ProfilePayloadSchema.
export class ProfilePayloadDto {
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  name: string;

  // Required at registration so notification-dispatcher has an address for
  // booking/listing emails — never a login credential, auth stays
  // phone/OTP only.
  @IsEmail({}, { message: 'Enter a valid email address' })
  email: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Pick at least one language' })
  @IsString({ each: true })
  languages: string[];

  // Guest is the permanent, implicit baseline for every account — this is
  // the only signup-time choice: add host capability on top, or don't.
  @IsOptional()
  @IsBoolean()
  isHost?: boolean = false;

  @IsString()
  @MinLength(1, { message: 'Avatar is required' })
  avatar_url: string;
}
