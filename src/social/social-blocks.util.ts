import type { Repository } from 'typeorm';
import { UserBlockEntity } from '../entities';

/**
 * Ids the user has blocked or been blocked by. Blocks are symmetric for every
 * social surface: neither side sees the other.
 */
export async function findBlockRelatedUserIds(
  blocksRepo: Repository<UserBlockEntity>,
  userId: string,
): Promise<Set<string>> {
  const rows = await blocksRepo
    .createQueryBuilder('b')
    .select(['b.blocker_id', 'b.blocked_id'])
    .where('b.blocker_id = :userId OR b.blocked_id = :userId', { userId })
    .getMany();
  const related = new Set<string>();
  for (const row of rows)
    related.add(row.blocker_id === userId ? row.blocked_id : row.blocker_id);
  return related;
}

/** Drops every candidate id that is in a block relationship with `userId`, in either direction. */
export async function excludeBlockedUserIds(
  blocksRepo: Repository<UserBlockEntity>,
  userId: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const related = await findBlockRelatedUserIds(blocksRepo, userId);
  return candidateIds.filter((id) => !related.has(id));
}
