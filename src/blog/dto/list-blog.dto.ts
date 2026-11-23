import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListBlogQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;

  @IsOptional()
  // eslint-disable-next-line no-control-regex
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\u0000/g, '') : value))
  @IsString()
  @MaxLength(60)
  category?: string;
}
