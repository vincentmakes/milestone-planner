/**
 * The request note in My Work (r9): the approver reads the requester's
 * message with its mentions as pills (never raw `@[Name](id)` tokens), and
 * the requester sees their own message as "Your message", apart from the
 * decider's note. HistoryRow: a closed request with its outcome, who asked,
 * their message, the decision note and time, and no action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalRequestRow, HistoryRow, MyRequestRow } from '../ApprovalRequestRow';
import { decidedWhen } from '../requestText';
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

describe('HistoryRow', () => {
  const closed = makeApprovalRequest({
    status: 'rejected',
    requester_name: 'Bob Brown',
    decided_by: 42,
    decided_by_name: 'Paula Manager',
    decided_at: '2026-10-21T14:05:00.000Z',
    decision_note: 'Fully booked that week',
    note: 'Ask @[Alice Anderson](7)',
  });

  it('shows the outcome, who asked, both notes and the decision time', () => {
    render(
      <ul>
        <HistoryRow request={closed} />
      </ul>
    );
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Bob Brown wants to join Feasibility of Bioprocess Scale-Up at 40%');
    expect(screen.getByText('Rejected by Paula Manager')).toBeInTheDocument();
    expect(item).toHaveTextContent('Requested by Bob Brown');
    expect(item).toHaveTextContent('Message: Ask @Alice Anderson');
    expect(item).toHaveTextContent('“Fully booked that week”');
    expect(screen.getByTitle('Decided')).toHaveTextContent(decidedWhen(closed));
    // The card link is the one button: no Approve, Reject or Cancel on a closed row.
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Feasibility']);
  });

  it('shows a dash for a request closed without a decision time, and no empty notes', () => {
    render(
      <ul>
        <HistoryRow
          request={makeApprovalRequest({ status: 'expired', requester_name: null, decided_at: null, note: null })}
        />
      </ul>
    );
    const item = screen.getByRole('listitem');
    expect(item).toHaveTextContent('Requested by someone');
    expect(screen.getByTitle('Decided')).toHaveTextContent('—');
    expect(item).not.toHaveTextContent('Message:');
  });
});
