import { IsString, MinLength } from 'class-validator';

// The client uploads the file to Supabase Storage via the existing
// POST /api/storage/upload-url flow (bucket: 'selfies'), then POSTs the
// resulting path here to record it against the profile. No liveness or
// face-match check — same mocked-trust posture as the rest of KYC.
export class SelfieVerificationDto {
  @IsString()
  @MinLength(1)
  selfiePath: string;
}
