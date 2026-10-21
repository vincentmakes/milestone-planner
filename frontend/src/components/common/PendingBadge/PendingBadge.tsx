/**
 * PendingBadge — the pill on a staff booking awaiting approval.
 *
 * The label says what is pending (the booking itself, a change, a removal);
 * the tooltip names who decides (the project manager when the policy lets
 * managers approve, the policy's roles, always the administrators). Renders
 * nothing for an approved row without an open request.
 */

import { useApproverSummary } from '@/hooks/useApprovalPolicies';
import { isPendingAssignment } from '@/utils/kanbanCards';
import type { StaffAssignment } from '@/types';
import styles from './PendingBadge.module.css';

export interface PendingBadgeProps {
  assignment: Pick<StaffAssignment, 'approval_status' | 'approval'>;
  /** The booking's project, for its manager's name in the tooltip */
  projectId: number | null | undefined;
  className?: string;
}

const LABELS: Record<string, string> = {
  'assignments.self_create': 'Pending approval',
  'assignments.self_update': 'Change pending',
  'assignments.self_remove': 'Removal requested',
};

export function PendingBadge({ assignment, projectId, className }: PendingBadgeProps) {
  const pending = isPendingAssignment(assignment);
  if (!pending && !assignment.approval) return null;
  const action = assignment.approval?.action ?? 'assignments.self_create';
  return <PendingPill action={action} projectId={projectId} className={className} />;
}

function PendingPill({
  action,
  projectId,
  className,
}: {
  action: string;
  projectId: number | null | undefined;
  className?: string;
}) {
  const title = useApproverSummary(action, projectId);
  const removal = action === 'assignments.self_remove';
  return (
    <span
      className={[styles.badge, removal ? styles.removal : '', className].filter(Boolean).join(' ')}
      title={title}
    >
      {LABELS[action] ?? LABELS['assignments.self_create']}
    </span>
  );
}
