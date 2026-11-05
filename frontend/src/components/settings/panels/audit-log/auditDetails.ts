/**
 * Reading an audit row: its target, its timestamp and the parts of its
 * `details` (`reason`, `changes`, `items`, `context` — the backend's
 * contract), with the field names and values a person can read.
 *
 * A credential is recorded as `"***"` (shown as a "Secret value" chip by the
 * entry dialog) and a long value as `{changed: true, length}` ("changed (n
 * characters)"); `isMasked` / `formatAuditValue` tell them apart.
 */

import { entityLabel } from '@/utils/auditLabels';
import type { AuditLogChange, AuditLogEntry } from '@/types';

export const EMPTY_VALUE = '—';

/** The colour of an audit chip (`AuditChip`). */
export type AuditChipTone = 'info' | 'warning' | 'accent' | 'neutral' | 'success' | 'error';

/** Authentication info, Administration warning, Data access accent, Changes (and anything else) neutral. */
export function categoryTone(category: string): AuditChipTone {
  switch (category) {
    case 'auth':
      return 'info';
    case 'admin':
      return 'warning';
    case 'access':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function outcomeTone(outcome: string): AuditChipTone {
  if (outcome === 'success') return 'success';
  if (outcome === 'failure') return 'error';
  return 'neutral';
}

/** Fields whose label is not their name with spaces. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  site_ids: 'Sites',
  team_ids: 'Teams',
  skill_ids: 'Skills',
  member_ids: 'Members',
  role_ids: 'Approver roles',
  pm_approves: 'Project manager approves',
  is_resource: 'Bookable',
  sessions_revoked: 'Sessions revoked',
  retry_after: 'Retry after (seconds)',
  stored_value: 'Stored secret used',
  site_id: 'Site',
  tenant_id: 'Tenant ID',
  client_id: 'Client ID',
  redirect_uri: 'Redirect URI',
  auto_create_users: 'Auto-create users',
  country_code: 'Country',
  region_code: 'Region',
};

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A credential, masked when it was recorded. */
export function isMasked(value: unknown): boolean {
  return value === '***';
}

/** `{changed: true, length}`: a value too long to keep. */
export function isLongValue(value: unknown): value is { changed: true; length: number } {
  return isPlainObject(value) && value.changed === true && typeof value.length === 'number';
}

/** A recorded timestamp in the browser's local date and time. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** "First name" for `first_name`; a dotted key (a permission) as recorded. */
export function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key];
  if (known) return known;
  if (key.includes('.')) return key;
  const text = key.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The text of a recorded value (a masked one reads "Secret value"; the dialog shows it as a chip). */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return EMPTY_VALUE;
  if (isMasked(value)) return 'Secret value';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return ISO_TIMESTAMP.test(value) ? formatWhen(value) : value;
  if (Array.isArray(value)) return value.length === 0 ? EMPTY_VALUE : value.map(formatAuditValue).join(', ');
  if (isLongValue(value)) return `changed (${value.length.toLocaleString()} characters)`;
  return JSON.stringify(value);
}

/** "{Type} · {label}" (label falling back to `#id`), "{Type}" alone, or "—". */
export function targetText(entry: Pick<AuditLogEntry, 'target_type' | 'target_id' | 'target_label'>): string {
  if (!entry.target_type) return EMPTY_VALUE;
  const type = entityLabel(entry.target_type);
  const label = entry.target_label || (entry.target_id ? `#${entry.target_id}` : '');
  return label ? `${type} · ${label}` : type;
}

export interface DescribedDetails {
  reason: string | null;
  changes: Array<[string, AuditLogChange]>;
  items: Array<Record<string, unknown>>;
  context: Array<[string, unknown]>;
}

/** The parts of a row's `details` worth showing, in recorded order. */
export function describeDetails(details: unknown): DescribedDetails {
  const out: DescribedDetails = { reason: null, changes: [], items: [], context: [] };
  if (!isPlainObject(details)) return out;
  if (typeof details.reason === 'string' && details.reason) out.reason = details.reason;
  if (isPlainObject(details.changes)) {
    for (const [key, pair] of Object.entries(details.changes)) {
      if (isPlainObject(pair) && 'old' in pair && 'new' in pair) {
        out.changes.push([key, { old: pair.old, new: pair.new }]);
      } else {
        out.context.push([key, pair]);
      }
    }
  }
  if (Array.isArray(details.items)) out.items = details.items.filter(isPlainObject);
  if (isPlainObject(details.context)) out.context.push(...Object.entries(details.context));
  return out;
}

/** Whether `describeDetails` found nothing to show below the reason. */
export function hasNoDetails(described: DescribedDetails): boolean {
  return described.changes.length === 0 && described.items.length === 0 && described.context.length === 0;
}
