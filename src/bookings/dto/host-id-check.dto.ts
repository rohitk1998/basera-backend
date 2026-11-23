import { IsIn, IsOptional } from 'class-validator';

// Document TYPE only. RhenBasera never receives or stores an ID number or image.
export const HOST_ID_CHECK_DOC_TYPES = [
  'aadhaar',
  'passport',
  'driving_licence',
  'voter_id',
  'other',
] as const;

export type HostIdCheckDocType = (typeof HOST_ID_CHECK_DOC_TYPES)[number];

export class HostIdCheckDto {
  @IsOptional()
  @IsIn(HOST_ID_CHECK_DOC_TYPES)
  docType?: HostIdCheckDocType;
}
