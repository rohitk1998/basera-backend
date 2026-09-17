import { IsIn } from 'class-validator';

// Multipart field alongside the uploaded file — see
// VerificationController.submitIdentity/resubmitIdentity.
export class SubmitIdentityDto {
  @IsIn(['aadhaar', 'passport', 'driving_licence'])
  documentSubtype: 'aadhaar' | 'passport' | 'driving_licence';
}
