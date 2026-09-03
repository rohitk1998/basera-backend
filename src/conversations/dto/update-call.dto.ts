import { IsIn } from 'class-validator';

export class UpdateCallDto {
  @IsIn(['accepted', 'declined', 'missed', 'ended'])
  status: 'accepted' | 'declined' | 'missed' | 'ended';
}
