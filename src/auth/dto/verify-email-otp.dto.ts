import { IsEmail, Matches } from 'class-validator';

export class VerifyEmailOtpDto {
  @IsEmail()
  email: string;

  // Exactly 6 digits — same shape the frontend code-entry screen collects.
  @Matches(/^\d{6}$/, { message: 'Code must be 6 digits.' })
  code: string;
}
