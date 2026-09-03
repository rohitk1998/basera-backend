import { IsString, MinLength } from 'class-validator';

export class SetLocaleDto {
  @IsString()
  @MinLength(2)
  locale: string;
}
