import { IsIn } from 'class-validator';

export class ModerateStoryDto {
  @IsIn(['published', 'rejected'])
  status: 'published' | 'rejected';
}
