import { Matches } from 'class-validator';

// Multipart field alongside the uploaded certificate file — see
// VerificationController.submitLegal/resubmitLegal.
export class SubmitLegalDto {
  @Matches(/^HP\/HS\/\d{3,5}\/\d{4}$/i, { message: 'Format: HP/HS/1234/2025.' })
  registrationNumber: string;
}
