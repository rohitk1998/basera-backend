import { IsIn, IsOptional } from 'class-validator';

export class ListBookingsQueryDto {
  @IsOptional()
  @IsIn(['host', 'guest'])
  role?: 'host' | 'guest';
}
