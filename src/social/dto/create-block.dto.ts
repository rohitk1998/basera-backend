import { IsUUID } from 'class-validator';

export class CreateBlockDto {
  @IsUUID()
  userId: string;
}
