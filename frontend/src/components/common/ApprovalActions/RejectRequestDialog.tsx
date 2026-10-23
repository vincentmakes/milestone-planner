/**
 * RejectRequestDialog — rejects a booking request with an optional reason for
 * the requester. A small dialog on the shared Modal (never a browser prompt):
 * Escape or Cancel closes it, a failure shows in place, and the submit guard
 * keeps a double click from rejecting twice.
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Notice } from '@/components/common/Notice';
import { useSubmitGuard } from '@/components/common/useSubmitGuard';

export interface RejectRequestDialogProps {
  isOpen: boolean;
  /** Whose request, e.g. the requester's name */
  subject?: string | null;
  onClose: () => void;
  /** Rejects; a throw keeps the dialog open with the message */
  onReject: (note: string | undefined) => Promise<void>;
}

export function RejectRequestDialog({ isOpen, subject, onClose, onReject }: RejectRequestDialogProps) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { isSubmitting, begin, end } = useSubmitGuard();

  useEffect(() => {
    if (!isOpen) {
      setNote('');
      setError(null);
    }
  }, [isOpen]);

  const handleReject = async () => {
    if (!begin()) return;
    setError(null);
    try {
      await onReject(note.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reject the request');
    } finally {
      end();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Reject request"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleReject} loading={isSubmitting} disabled={isSubmitting}>
            Reject
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleReject();
        }}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <p>
          Reject {subject ? `${subject}'s` : 'this'} booking request? The requester is notified.
        </p>
        <Input
          label="Reason (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          fullWidth
          autoFocus
        />
      </form>
    </Modal>
  );
}
