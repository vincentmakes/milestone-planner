/**
 * Renders a stored comment body, turning `@[Name](id)` tokens into styled
 * mentions.
 *
 * Built from React children, never `dangerouslySetInnerHTML` — escaping comes
 * free and there is no way for a comment body to inject markup. Keep it that
 * way.
 *
 * A comment written before mentions existed contains no tokens and renders
 * exactly as it always did.
 */

import { useMemo } from 'react';
import { parseMentionTokens } from '@/utils/mentions';
import styles from './MentionTextarea.module.css';

interface MentionTextProps {
  body: string;
  /** The reader, so a mention of them can stand out. */
  meUserId?: number;
}

export function MentionText({ body, meUserId }: MentionTextProps) {
  const segments = useMemo(() => parseMentionTokens(body), [body]);

  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === 'mention' ? (
          <span
            key={i}
            className={`${styles.mention} ${segment.userId === meUserId ? styles.mentionMe : ''}`}
          >
            {segment.text}
          </span>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      )}
    </>
  );
}
