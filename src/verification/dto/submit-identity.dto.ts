import { IsIn } from 'class-validator';

// Multipart field alongside the uploaded files — see
// VerificationController.submitIdentity/resubmitIdentity.
export class SubmitIdentityDto {
  @IsIn(['aadhaar'])
  documentSubtype: 'aadhaar';
}
