import { IsIn } from 'class-validator';

export class SubscribeDto {
  @IsIn(['listed', 'featured', 'pro'])
  planId: 'listed' | 'featured' | 'pro';
}
