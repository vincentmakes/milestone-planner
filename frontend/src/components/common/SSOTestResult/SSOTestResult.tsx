/**
 * SSOTestResult — the outcome of a Microsoft Entra SSO test: the summary, then
 * one row per check with its mark (pass, fail, warn, manual = a question
 * mark), its name, Microsoft's AADSTS code when there is one, and its message.
 *
 * Shared by Settings → SSO (the tenant's entered values) and the admin
 * portal's organization details (the saved values).
 */

import type { SSOTestCheck, SSOTestResult as SSOTestResultData } from '@/api/endpoints/sso';
import { Icon, CheckCircleIcon, CancelIcon, WarningIcon, HelpIcon } from '@/components/common/Icon';
import type { IconComponent } from '@/components/common/Icon';
import styles from './SSOTestResult.module.css';

/** The mark in front of each check (manual checks: a question mark). */
const SSO_CHECK_ICONS: Record<SSOTestCheck['status'], IconComponent> = {
  pass: CheckCircleIcon,
  fail: CancelIcon,
  warn: WarningIcon,
  manual: HelpIcon,
};

export interface SSOTestResultProps {
  result: SSOTestResultData;
  className?: string;
}

export function SSOTestResult({ result, className }: SSOTestResultProps) {
  return (
    <div className={[styles.result, className].filter(Boolean).join(' ')} role="status">
      <div className={styles.summary}>{result.summary}</div>
      {result.checks.map((check, index) => (
        // Row → [mark, text → [name (+ code), message]]: tests find a check's
        // mark from its name through this shape.
        <div key={`${check.name}-${index}`} className={styles.check}>
          <span aria-hidden="true" className={`${styles.mark} ${styles[check.status] ?? ''}`}>
            <Icon icon={SSO_CHECK_ICONS[check.status] ?? HelpIcon} size={16} />
          </span>
          <div>
            <div className={styles.name}>
              {check.name}
              {check.code && <span className={styles.code}> ({check.code})</span>}
            </div>
            <div className={styles.message}>{check.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
