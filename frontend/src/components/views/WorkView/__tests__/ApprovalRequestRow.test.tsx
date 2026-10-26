/**
 * The request note in My Work (r9): the approver reads the requester's
 * message with its mentions as pills (never raw `@[Name](id)` tokens), and
 * the requester sees their own message as "Your message", apart from the
 * decider's note.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalRequestRow, MyRequestRow } from '../ApprovalRequestRow';
import { useAppStore } from '@/stores/appStore';
import { makeApprovalRequest, makeUser } from '@/test/factories';
import mentionStyles from '@/components/common/MentionTextarea/MentionTextarea.module.css';

const NOTE = 'Can I join? Ask @[Alice Anderson](7) or @[Paula Manager](42)';

beforeEach(() => {
  useAppStore.setState({ currentUser: makeUser({ id: 42, role: 'user' }) });
});

describe('ApprovalRequestRow', () => {
  it('renders the request note with mention pills, the reader highlighted', () => {
    render(
      <ul>
        <ApprovalRequestRow request={makeApprovalRequest({ note: NOTE })} onDecided={vi.fn()} onError={vi.fn()} />
      </ul>
    );

    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('“Can I join? Ask @Alice Anderson or @Paula Manager”');
    expect(item).not.toHaveTextContent('@[');
    const alice = screen.getByText('@Alice Anderson');
    expect(alice).toHaveClass(mentionStyles.mention);
    expect(alice).not.toHaveClass(mentionStyles.mentionMe);
    expect(screen.getByText('@Paula Manager')).toHaveClass(mentionStyles.mentionMe);
  });

  it('shows no note line without a note', () => {
    render(
      <ul>
        <ApprovalRequestRow request={makeApprovalRequest({ note: null })} onDecided={vi.fn()} onError={vi.fn()} />
      </ul>
    );
    expect(screen.getByRole('listitem')).not.toHaveTextContent('“');
  });
});

describe('MyRequestRow', () => {
  it('labels my own message apart from the decider note', () => {
    useAppStore.setState({ currentUser: makeUser({ id: 4, role: 'user' }) });
    render(
      <ul>
        <MyRequestRow
          request={makeApprovalRequest({ status: 'rejected', note: NOTE, decision_note: 'Fully staffed' })}
          onCancel={vi.fn()}
        />
      </ul>
    );

    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Your message: Can I join? Ask @Alice Anderson or @Paula Manager');
    expect(screen.getByText('@Alice Anderson')).toHaveClass(mentionStyles.mention);
    expect(item).toHaveTextContent('“Fully staffed”');
  });

  it('shows no message line without a note', () => {
    render(
      <ul>
        <MyRequestRow request={makeApprovalRequest({ note: null })} onCancel={vi.fn()} />
      </ul>
    );
    expect(screen.queryByText(/Your message/)).not.toBeInTheDocument();
  });
});
