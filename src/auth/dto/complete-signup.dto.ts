import { ArrayMinSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

// Ported from ProfilePayloadDto (user/dto/profile-payload.dto.ts) — same
// user-facing fields, same validation. This DTO additionally carries the
// short-lived proof-of-identity token minted by session()/verifyEmailOtp()
// for a brand-new signup (see AuthController.completeSignup). The token
// travels as its own field rather than a cookie/header because at this
// point in the flow there is deliberately no session cookie yet to piggy
// back on.
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

  // Empty string, not required — the browser can't upload the avatar file
  // until this call succeeds and issues a real session, so ProfileScreen
  // completes the account first without one and immediately follows up
  // with a PATCH /api/user/profile carrying the uploaded avatar_url.
  @IsOptional()
  @IsString()
  avatar_url?: string;

  // The proof-of-identity JWT from session()/verifyEmailOtp()'s isNewUser
  // response — verified server-side before any row is created. Not part of
  // ProfilePayloadSchema on the frontend since it's not a user-facing form
  // field; see web/lib/validations.ts for why it's kept separate from zod
  // validation of the visible fields.
  @IsString()
  @MinLength(1)
  proofToken: string;
}
