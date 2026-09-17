import { IsIn } from 'class-validator';

export class DisputeRespondDto {
  @IsIn(['accept', 'reject', 'escalate'])
  action: 'accept' | 'reject' | 'escalate';
}
