/**
 * ApprovalActions — inline Approve / Reject on a booking awaiting approval,
 * for a decider (the row's `approval.can_decide`; the server checks again).
 * Approve decides at once; Reject asks for an optional reason in
 * RejectRequestDialog. `onDecided` refreshes the caller's data afterwards —
 * also after a 409, when the request was decided or expired meanwhile, so
 * the row shows what really happened. Errors go to `onError` (the caller's
 * Notice or flash), never an alert.
 */

import { useState } from 'react';
import { Button } from '@/components/common/Button';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';
import { approvalsApi } from '@/api/endpoints/approvals';
import { ApiError } from '@/api/client';
import { RejectRequestDialog } from './RejectRequestDialog';
import styles from './ApprovalActions.module.css';

export interface ApprovalActionsProps {
  requestId: number;
  /** Whose request (the requester's name), for the labels */
  subject?: string | null;
  onDecided: () => void | Promise<void>;
  onError: (message: string) => void;
  /** Disables both buttons with this tooltip (e.g. during What-If) */
  disabledReason?: string | null;
}

/** A 409 means the request is no longer pending: refresh to show its fate. */
function isStale(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

export function ApprovalActions({ requestId, subject, onDecided, onError, disabledReason }: ApprovalActionsProps) {
  const { isSubmitting, begin, end } = useSubmitGuard();
  const [rejecting, setRejecting] = useState(false);
  const who = subject ?? 'request';

  const handleApprove = async () => {
    if (!begin()) return;
    try {
      await approvalsApi.approve(requestId);
      await onDecided();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not approve the request');
      if (isStale(err)) await onDecided();
    } finally {
      end();
    }
  };

  const handleReject = async (note: string | undefined) => {
    await approvalsApi.reject(requestId, note);
    await onDecided();
  };

  const disabled = isSubmitting || Boolean(disabledReason);
  return (
    <span className={styles.actions}>
      <Button
        size="sm"
        variant="secondary"
        onClick={handleApprove}
        disabled={disabled}
        loading={isSubmitting}
        title={disabledReason ?? undefined}
        aria-label={`Approve ${who}`}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setRejecting(true)}
        disabled={disabled}
        title={disabledReason ?? undefined}
        aria-label={`Reject ${who}`}
      >
        Reject
      </Button>
      <RejectRequestDialog
        isOpen={rejecting}
        subject={subject}
        onClose={() => setRejecting(false)}
        onReject={handleReject}
      />
    </span>
  );
}
