/**
 * AuditLogEntryModal — "Entry detail" of one audit row (Settings → General →
 * Audit log, a row click or Enter on a focused row).
 *
 * The action's label with its raw key, the category / outcome / origin chips,
 * who and what (Actor, Account, Target, Project, IP address, User agent), the
 * reason ("Wrong password (bad_password)"), then "Details": the changes as a
 * Field / Before / After table and the context as a definition list, or "No
 * further details recorded.". View-only: a single Close, and Escape.
 */

import { Fragment } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { actionLabel, categoryLabel, originLabel, outcomeLabel, reasonLabel } from '@/utils/auditLabels';
import type { AuditLogEntry } from '@/types';
import {
  categoryTone,
  describeDetails,
  EMPTY_VALUE,
  fieldLabel,
  formatAuditValue,
  formatWhen,
  hasNoDetails,
  isMasked,
  outcomeTone,
  targetText,
} from './auditDetails';
import { AuditChip } from './AuditChip';
import styles from './AuditLogPanel.module.css';

export interface AuditLogEntryModalProps {
  entry: AuditLogEntry | null;
  onClose: () => void;
}

/** A recorded value: a masked one is a "Secret value" chip. */
function AuditValue({ value }: { value: unknown }) {
  if (isMasked(value)) {
    return (
      <AuditChip tone="warning" variant="outlined">
        Secret value
      </AuditChip>
    );
  }
  return <>{formatAuditValue(value)}</>;
}

function text(value: string | null | undefined): string {
  return value || EMPTY_VALUE;
}

export function AuditLogEntryModal({ entry, onClose }: AuditLogEntryModalProps) {
  return (
    <Modal
      isOpen={entry !== null}
      onClose={onClose}
      title="Entry detail"
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {entry && <EntryBody entry={entry} />}
    </Modal>
  );
}

function EntryBody({ entry }: { entry: AuditLogEntry }) {
  const described = describeDetails(entry.details);
  const actor = entry.actor_name || entry.actor_email;

  return (
    <div className={styles.entry}>
      <div className={styles.entryHeading}>
        <span className={styles.entryAction}>{actionLabel(entry.action)}</span>
        <code className={styles.code}>{entry.action}</code>
      </div>
      <div className={styles.entryChips}>
        <AuditChip tone={categoryTone(entry.category)} variant="outlined">
          {categoryLabel(entry.category)}
        </AuditChip>
        <AuditChip tone={outcomeTone(entry.outcome)} variant="filled">
          {outcomeLabel(entry.outcome)}
        </AuditChip>
        <AuditChip tone="neutral" variant="outlined">
          {originLabel(entry.origin)}
        </AuditChip>
      </div>

      <dl className={styles.definitions}>
        <dt>When</dt>
        <dd>{formatWhen(entry.created_at)}</dd>
        <dt>Actor</dt>
        <dd>
          {text(actor)}
          {entry.actor_name && entry.actor_email && <span className={styles.muted}> {entry.actor_email}</span>}
        </dd>
        <dt>Account</dt>
        <dd>{text(entry.subject_email)}</dd>
        <dt>Target</dt>
        <dd>{targetText(entry)}</dd>
        {entry.project_id !== null && (
          <>
            <dt>Project</dt>
            <dd>{entry.project_name || `#${entry.project_id}`}</dd>
          </>
        )}
        <dt>IP address</dt>
        <dd>{entry.ip ? <code className={styles.code}>{entry.ip}</code> : EMPTY_VALUE}</dd>
        <dt>User agent</dt>
        <dd className={styles.breakAll}>{text(entry.user_agent)}</dd>
        {described.reason && (
          <>
            <dt>Reason</dt>
            <dd>
              {reasonLabel(described.reason)} ({described.reason})
            </dd>
          </>
        )}
      </dl>

      <h4 className={styles.entrySection}>Details</h4>
      {hasNoDetails(described) ? (
        <p className={styles.muted}>No further details recorded.</p>
      ) : (
        <>
          {described.changes.length > 0 && (
            <>
              <h5 className={styles.entrySubsection}>Changes</h5>
              <table className={styles.changes}>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {described.changes.map(([field, change]) => (
                    <tr key={field}>
                      <th scope="row" title={field}>
                        {fieldLabel(field)}
                      </th>
                      <td>
                        <AuditValue value={change.old} />
                      </td>
                      <td>
                        <AuditValue value={change.new} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {described.items.length > 0 && (
            <>
              <h5 className={styles.entrySubsection}>Items</h5>
              <ul className={styles.items}>
                {described.items.map((item, index) => (
                  <li key={index}>
                    {Object.entries(item)
                      .map(([key, value]) => `${fieldLabel(key)}: ${formatAuditValue(value)}`)
                      .join(' · ')}
                  </li>
                ))}
              </ul>
            </>
          )}
          {described.context.length > 0 && (
            <>
              <h5 className={styles.entrySubsection}>Context</h5>
              <dl className={styles.definitions}>
                {described.context.map(([key, value]) => (
                  <Fragment key={key}>
                    <dt title={key}>{fieldLabel(key)}</dt>
                    <dd>
                      <AuditValue value={value} />
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </>
          )}
        </>
      )}
    </div>
  );
}
