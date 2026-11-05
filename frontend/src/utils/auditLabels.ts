/**
 * Readable labels of the audit log (Settings → General → Audit log).
 *
 * The sign-in, export and reason labels are turbo-ea's English strings
 * (`securityLog.actionLabels.*`, `securityLog.reasons.*`). Every other action
 * follows one rule: `admin.<entity>.<verb>` and `<entity>.<verb>` read
 * "{Entity label} {verb}" ("User updated", "Booking deleted", "Role
 * permissions updated"). A key of any other shape, and a reason this build
 * does not know, are shown as recorded.
 */

/** Exact labels: the auth and access keys (app/routers/auth.py, export.py, audit_log.py). */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'auth.login.succeeded': 'Sign-in succeeded',
  'auth.login.failed': 'Sign-in failed',
  'auth.login.locked': 'Account locked after failed sign-ins',
  'auth.logout': 'Signed out',
  'auth.sso.succeeded': 'SSO sign-in succeeded',
  'auth.sso.failed': 'SSO sign-in failed',
  'auth.password.changed': 'Password changed',
  'access.audit_log.exported': 'Audit log exported',
  'access.export.site': 'Site exported',
  'access.export.msproject': 'MS Project exported',
  'access.export.csv': 'CSV exported',
};

/** Entities whose label is not their capitalised name. */
const ENTITY_LABELS: Readonly<Record<string, string>> = {
  staff_assignment: 'Booking',
  equipment_assignment: 'Equipment booking',
  approval_request: 'Approval request',
  card_comment: 'Comment',
  predefined_phase: 'Phase template',
  bank_holiday: 'Bank holiday',
  company_event: 'Company event',
  equipment_block: 'Equipment block',
  custom_column: 'Custom column',
  project_field: 'Project field',
  absence_type: 'Absence type',
  approval_policy: 'Approval policy',
  vacation: 'Absence',
  note: 'Staff note',
  sso: 'SSO',
  audit_log: 'Audit log',
};

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  auth: 'Authentication',
  admin: 'Administration',
  access: 'Data access',
  change: 'Changes',
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  success: 'Success',
  failure: 'Failure',
};

const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  web: 'Web',
  system: 'System',
};

/** Reason codes (`details.reason`): the sign-in and SSO failures, then the SSO test's failed check. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  bad_password: 'Wrong password',
  unknown_user: 'No account with this email',
  throttled: 'Account temporarily locked',
  inactive: 'Account disabled',
  config_missing: 'SSO is not configured',
  exchange_failed: 'The identity provider did not complete the sign-in',
  graph_failed: 'The Microsoft Graph lookup failed',
  group_denied: 'Not a member of an allowed group',
  no_email: 'Identity provider returned no email',
  no_account: 'No account exists and accounts are not created automatically',
  client_secret: 'The client secret check failed',
  redirect_uri: 'The redirect URI check failed',
  outbound_network: 'The outbound network check failed',
  microsoft_directory: 'The Microsoft directory check failed',
  client_credentials: 'The client credentials check failed',
  microsoft_sign_in: 'The Microsoft sign-in check failed',
  rejected: 'The credentials were rejected',
};

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Booking" for `staff_assignment`; else the name with spaces, capitalised ("Absence type"). */
export function entityLabel(entity: string): string {
  return ENTITY_LABELS[entity] ?? capitalise(entity.replace(/_/g, ' '));
}

/** The readable label of an action key (the raw key when it has no known shape). */
export function actionLabel(key: string): string {
  const exact = ACTION_LABELS[key];
  if (exact) return exact;
  const parts = key.split('.');
  let entity: string | undefined;
  let verb: string | undefined;
  if (parts.length === 3 && parts[0] === 'admin') [, entity, verb] = parts;
  else if (parts.length === 2 && parts[0] !== 'auth' && parts[0] !== 'access' && parts[0] !== 'admin') {
    [entity, verb] = parts;
  }
  if (!entity || !verb || !IDENTIFIER.test(entity) || !IDENTIFIER.test(verb)) return key;
  return `${entityLabel(entity)} ${verb.replace(/_/g, ' ')}`;
}

/** The readable label of a reason code (the code itself when unknown). */
export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export function originLabel(origin: string): string {
  return ORIGIN_LABELS[origin] ?? origin;
}
