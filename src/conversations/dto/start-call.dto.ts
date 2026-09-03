import { IsIn } from 'class-validator';

export class StartCallDto {
  @IsIn(['voice', 'video'])
  kind: 'voice' | 'video';
}
