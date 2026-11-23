export type ParamValue = number | boolean | number[];
export type AutomationParams = Record<string, ParamValue>;

export type ParamSpec =
  | { type: 'int'; min: number; max: number }
  | { type: 'bool' }
  | { type: 'intArray'; min: number; max: number; minLen: number; maxLen: number };

/** One row returned by a definition's SQL. Everything beyond subject_id is optional context. */
export interface CandidateRow {
  subject_id: string;
  /** Recipient user. null/undefined for audience 'admin' (and the fallback for 'staff'). */
  user_id?: string | null;
  age_hours?: number | string | null;
  title?: string | null;
  name?: string | null;
  phone?: string | null;
  [k: string]: unknown;
}

export type Audience = 'user' | 'admin' | 'staff';

export interface WhatsappPlan {
  template: 'claim_reminder' | 'payment_reminder' | 'inquiry_alert' | 'offer_sent' | 'booking_confirmed' | 'host_invitation';
  params: Record<string, string>;
}

export interface AutomationDef {
  kind: string;
  title: string;
  description: string;
  audience: Audience;
  subjectType: string;
  /** NotificationEvent name (cast: new events fall back to the event name as the feed title; push/email use data.pushTitle/pushBody). */
  event: string;
  defaultParams: AutomationParams;
  paramSpec: Record<string, ParamSpec>;
  /** Tables the SQL reads; the run is skipped (not failed) when any is missing. */
  requires: string[];
  /** READ-ONLY SQL. $1 is always `now` (timestamptz); remaining params are returned by this builder. */
  query(params: AutomationParams): { sql: string; args: unknown[] };
  bucket(row: CandidateRow, params: AutomationParams): string | null;
  data(row: CandidateRow, params: AutomationParams, appUrl: string): Record<string, unknown>;
  whatsapp?(row: CandidateRow, params: AutomationParams, appUrl: string): WhatsappPlan | null;
}

export interface PlannedReminder {
  subjectId: string;
  bucket: string;
  recipients: 'admins' | string;
  alreadySent: boolean;
  title: string | null;
}

export interface RunSummary {
  kind: string;
  dryRun: boolean;
  skippedReason?: 'paused' | 'disabled' | 'missing_tables';
  missingTables?: string[];
  candidates: number;
  sent: number;
  alreadySent: number;
  failed: number;
  whatsappSent: number;
  whatsappBlocked: number;
  /** Only populated for dry runs (capped at 200). */
  wouldNotify?: PlannedReminder[];
}
