import { Fragment, useEffect, useRef } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useConfirmStore } from '@/stores/confirmStore';
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
 * The shared confirmation dialog: shows the head of `confirmStore`'s queue.
 * Mounted once in `App`, so it serves both the tenant app and the admin
 * portal. Ask through `confirmAction()` (`utils/confirmDialog.ts`).
 */
export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.queue[0]);
  const settle = useConfirmStore((s) => s.settle);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const requestId = request?.id;

  // Cancel is the safe default. This effect runs after Modal's own open
  // effect (parents' effects run after their children's), which focuses
  // the dialog container — autoFocus would be overridden by it.
  useEffect(() => {
    if (requestId !== undefined) cancelRef.current?.focus();
  }, [requestId]);

  if (!request) return null;

  const { id, title, message, confirmLabel, cancelLabel, destructive } = request;

  return (
    <Modal
      // One Modal per request: the next queued one opens fresh, and focus
      // returns to where it was before the first request once the queue is empty.
      key={id}
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
            onClick={() => settle(id, true)}
          >
            {confirmLabel ?? (destructive ? 'Delete' : 'Confirm')}
          </Button>
        </>
      }
    >
      <Message text={message} />
    </Modal>
  );
}
