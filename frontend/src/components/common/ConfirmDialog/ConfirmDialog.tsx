import { Fragment, useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Input } from '../Input';
import { useConfirmStore } from '@/stores/confirmStore';
import type { ConfirmRequest } from '@/stores/confirmStore';
import styles from './ConfirmDialog.module.css';

/** `\n\n` separates paragraphs; a single `\n` is a line break inside one. */
function Message({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== '');
  return (
    <div className={styles.message}>
      {paragraphs.map((paragraph, i) => (
        <p key={i}>
          {paragraph.split('\n').map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

/**
 * One request's dialog. Keyed by the request id, so the typed word (and the
 * Modal) never carries over to the next queued request: state kept in
 * `ConfirmDialog` itself would open the next one pre-filled, past its gate.
 */
function RequestDialog({ request }: { request: ConfirmRequest }) {
  const settle = useConfirmStore((s) => s.settle);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wordRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');

  const { id, title, message, confirmLabel, cancelLabel, destructive, confirmWord } = request;
  const matches = !confirmWord || typed.trim() === confirmWord;

  // Cancel is the safe default (the typed-word field when there is one). This
  // effect runs after Modal's own open effect (parents' effects run after
  // their children's), which focuses the dialog container — autoFocus would
  // be overridden by it.
  useEffect(() => {
    (wordRef.current ?? cancelRef.current)?.focus();
  }, []);

  const confirm = () => {
    if (matches) settle(id, true);
  };

  return (
    <Modal
      isOpen
      onClose={() => settle(id, false)}
      title={title ?? 'Please confirm'}
      size="sm"
      footer={
        <>
          <Button ref={cancelRef} type="button" variant="secondary" onClick={() => settle(id, false)}>
            {cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'danger' : 'primary'}
            disabled={!matches}
            onClick={confirm}
          >
            {confirmLabel ?? (destructive ? 'Delete' : 'Confirm')}
          </Button>
        </>
      }
    >
      <Message text={message} />
      {confirmWord && (
        <Input
          ref={wordRef}
          className={styles.word}
          label={`Type ${confirmWord} to confirm`}
          fullWidth
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            // Modal has no form and no Enter handling of its own.
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            confirm();
          }}
        />
      )}
    </Modal>
  );
}

/**
 * The shared confirmation dialog: shows the head of `confirmStore`'s queue.
 * Mounted once in `App`, so it serves both the tenant app and the admin
 * portal. Ask through `confirmAction()` (`utils/confirmDialog.ts`).
 */
export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.queue[0]);
  if (!request) return null;
  // One dialog per request: the next queued one opens fresh, and focus
  // returns to where it was before the first request once the queue is empty.
  return <RequestDialog key={request.id} request={request} />;
}
