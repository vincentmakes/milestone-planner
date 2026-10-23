/**
 * Inline decisions on a booking awaiting approval: Approve at once, Reject
 * through a dialog on the shared Modal with an optional reason (never a
 * browser prompt), both guarded against double clicks and both refreshing
 * the caller afterwards. Failures stay in place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalActions } from '../ApprovalActions';
import { RejectRequestDialog } from '../RejectRequestDialog';
import { approvalsApi } from '@/api/endpoints/approvals';
import { ApiError } from '@/api/client';

vi.mock('@/api/endpoints/approvals', () => ({
  approvalsApi: { approve: vi.fn(), reject: vi.fn() },
}));

const approve = vi.mocked(approvalsApi.approve);
const reject = vi.mocked(approvalsApi.reject);

beforeEach(() => {
  approve.mockReset().mockResolvedValue({ success: true, id: 31, status: 'approved' });
  reject.mockReset().mockResolvedValue({ success: true, id: 31, status: 'rejected' });
});

describe('ApprovalActions', () => {
  it('approves once even on a double click, then calls onDecided', async () => {
    const onDecided = vi.fn();
    render(<ApprovalActions requestId={31} subject="Bob Brown" onDecided={onDecided} onError={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Approve Bob Brown' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(31);
  });

  it('reports a failed approval and still refreshes on a 409', async () => {
    approve.mockRejectedValue(new ApiError('Request already approved', 409));
    const onDecided = vi.fn();
    const onError = vi.fn();
    render(<ApprovalActions requestId={31} subject="Bob Brown" onDecided={onDecided} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Bob Brown' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Request already approved'));
    // The request moved on meanwhile: show its current state.
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it('does not refresh after another failure', async () => {
    approve.mockRejectedValue(new Error('offline'));
    const onDecided = vi.fn();
    const onError = vi.fn();
    render(<ApprovalActions requestId={31} subject="Bob Brown" onDecided={onDecided} onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Bob Brown' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('offline'));
    expect(onDecided).not.toHaveBeenCalled();
  });

  it('rejects with a reason through the dialog', async () => {
    const onDecided = vi.fn();
    render(<ApprovalActions requestId={31} subject="Bob Brown" onDecided={onDecided} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject Bob Brown' }));
    expect(screen.getByRole('dialog', { name: 'Reject request' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Fully booked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1));
    expect(reject).toHaveBeenCalledWith(31, 'Fully booked');
    expect(screen.queryByRole('dialog', { name: 'Reject request' })).not.toBeInTheDocument();
  });

  it('disables both buttons with the reason when given', () => {
    render(
      <ApprovalActions
        requestId={31}
        subject="Bob Brown"
        onDecided={vi.fn()}
        onError={vi.fn()}
        disabledReason="Not available in What-If mode"
      />
    );
    for (const name of ['Approve Bob Brown', 'Reject Bob Brown']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Not available in What-If mode');
    }
  });
});

describe('RejectRequestDialog', () => {
  it('shows a failure in place and keeps the dialog open', async () => {
    const onReject = vi.fn().mockRejectedValue(new Error('Request already cancelled'));
    const onClose = vi.fn();
    render(<RejectRequestDialog isOpen subject="Bob Brown" onClose={onClose} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request already cancelled');
    expect(onReject).toHaveBeenCalledWith(undefined);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('rejects on Enter in the reason field', async () => {
    const onReject = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<RejectRequestDialog isOpen subject="Bob Brown" onClose={onClose} onReject={onReject} />);
    const reason = screen.getByLabelText('Reason (optional)');
    fireEvent.change(reason, { target: { value: '  Busy  ' } });
    fireEvent.submit(reason.closest('form')!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onReject).toHaveBeenCalledWith('Busy');
  });

  it('closes on Cancel without rejecting', () => {
    const onReject = vi.fn();
    const onClose = vi.fn();
    render(<RejectRequestDialog isOpen subject="Bob Brown" onClose={onClose} onReject={onReject} />);
    expect(screen.getByText(/Bob Brown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('rejects once on a double click', async () => {
    let release: () => void = () => {};
    const onReject = vi.fn(() => new Promise<void>((r) => (release = r)));
    const onClose = vi.fn();
    render(<RejectRequestDialog isOpen subject="Bob Brown" onClose={onClose} onReject={onReject} />);
    const button = screen.getByRole('button', { name: 'Reject' });
    fireEvent.click(button);
    fireEvent.click(button);
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
