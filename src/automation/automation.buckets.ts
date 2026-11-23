/**
 * Reminder bucketing (pure). A "bucket" names one reminder slot for a subject; reminder_log has
 * UNIQUE(kind, subject_id, bucket), so each slot fires at most once however often the sweep runs.
 */

/** Largest threshold (hours) already crossed by `ageHours`, as 'h<N>'; null while under the smallest one. */
export function ageBucket(ageHours: number, thresholdsHours: readonly number[]): string | null {
  if (!Number.isFinite(ageHours)) return null;
  let hit: number | null = null;
  for (const t of [...thresholdsHours].sort((a, b) => a - b)) if (ageHours >= t) hit = t;
  return hit === null ? null : `h${hit}`;
}

/** Smallest threshold: SQL pre-filters on it so only rows that can possibly bucket are fetched. */
export function minThreshold(thresholdsHours: readonly number[]): number {
  return Math.min(...thresholdsHours);
}

/** Fixed single-slot bucket (e.g. 'due', 'checkin'). */
export const fixedBucket = (name: string) => () => name;

/** Dedupe key handed to NotificationsService; one per (recipient, kind, subject, bucket). */
export function reminderDedupeKey(kind: string, subjectId: string, bucket: string): string {
  return `automation:${kind}:${subjectId}:${bucket}`;
}
