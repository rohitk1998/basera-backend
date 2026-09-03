import { IsBoolean } from 'class-validator';

export class BecomeHostDto {
  @IsBoolean()
  isHost: boolean;
}
