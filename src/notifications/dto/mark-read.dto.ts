import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

// Ported from web/lib .../mark-read/route.ts's zod union:
//   z.union([ z.object({ id: uuid }), z.object({ all: z.literal(true) }) ])
// class-validator has no native union type, so both fields are optional
// here and NotificationsService.markRead() re-validates the "exactly one
// of {id} or {all:true}" shape by hand, throwing the same 400 message the
// original route returned for anything else.
export class MarkReadDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}
