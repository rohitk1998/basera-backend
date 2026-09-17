import { IsEmail } from 'class-validator';

export class SendEmailOtpDto {
  @IsEmail()
  email: string;
}
