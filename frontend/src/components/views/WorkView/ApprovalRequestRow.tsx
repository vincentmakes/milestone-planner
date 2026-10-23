/**
 * My Work's request entries.
 *
 * ApprovalRequestRow — a request I may decide (My Approvals): the action
 * sentence, its card and age, the requester's note, and the shared
 * ApprovalActions (Approve at once, Reject with an optional reason; one
 * submit guard, `loading` while the write runs). `onDecided` drops it here
 * and reloads the projects (the booking row flips or disappears).
 *
 * MyRequestRow — one of my own requests (My Requests): the sentence, its
 * outcome, the decider's note, and Cancel while it is pending.
 */

import { Button } from '@/components/common/Button';
import { ApprovalActions } from '@/components/common/ApprovalActions';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { relativeTime } from '@/utils/relativeTime';
import { CardLink } from './CardLink';
import { describeRequest, requestOutcome } from './requestText';
import type { ApprovalRequest } from '@/types';
import styles from './WorkView.module.css';

function RequestCard({ request }: { request: ApprovalRequest }) {
  if (request.level === 'project' || !request.target_name) {
    return <span className={styles.cardName}>{request.project_name ?? 'Project'}</span>;
  }
  return (
    <CardLink
      entityType={request.level}
      entityId={request.target_id}
      projectId={request.project_id}
      label={request.target_name}
    />
  );
}

interface ApprovalRequestRowProps {
  request: ApprovalRequest;
  onDecided: (request: ApprovalRequest) => void | Promise<void>;
  onError: (message: string) => void;
}

export function ApprovalRequestRow({ request, onDecided, onError }: ApprovalRequestRowProps) {
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <span className={styles.itemTitle}>{describeRequest(request, 'decider')}</span>
        <span className={styles.itemMeta}>
          <RequestCard request={request} />
          {request.created_at && <span>{relativeTime(request.created_at)}</span>}
        </span>
        {request.note && <span className={styles.itemNote}>“{request.note}”</span>}
      </div>
      <ApprovalActions
        requestId={request.id}
        subject={request.requester_name}
        onDecided={() => onDecided(request)}
        onError={onError}
      />
    </li>
  );
}

interface MyRequestRowProps {
  request: ApprovalRequest;
  onCancel: (request: ApprovalRequest) => Promise<void>;
}

export function MyRequestRow({ request, onCancel }: MyRequestRowProps) {
  const { isSubmitting, guard } = useSubmitGuard();
  const pending = request.status === 'pending';
  return (
    <li className={styles.item}>
      <div className={styles.itemMain}>
        <span className={styles.itemTitle}>{describeRequest(request, 'requester')}</span>
        <span className={styles.itemMeta}>
          <span className={`${styles.statusChip} ${styles[`status_${request.status}`] ?? ''}`}>
            {requestOutcome(request)}
          </span>
          <RequestCard request={request} />
          {request.created_at && <span>{relativeTime(request.created_at)}</span>}
        </span>
        {request.decision_note && <span className={styles.itemNote}>“{request.decision_note}”</span>}
      </div>
      {pending && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void guard(() => onCancel(request))}
          loading={isSubmitting}
          disabled={isSubmitting}
        >
          Cancel request
        </Button>
      )}
    </li>
  );
}
