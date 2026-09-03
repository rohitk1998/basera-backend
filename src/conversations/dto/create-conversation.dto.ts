import { IsUUID } from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  listingId: string;
}
