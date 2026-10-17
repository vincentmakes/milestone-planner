/**
 * The header shows a small "Offline" badge while live sync is down
 * (WebSocketContext.offline), and nothing otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SyncStatus } from '../SyncStatus';

const ws = vi.hoisted(() => ({ offline: false }));
vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({ offline: ws.offline }),
}));

describe('SyncStatus', () => {
  it('renders nothing while live sync works', () => {
    ws.offline = false;
    const { container } = render(<SyncStatus />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an Offline status while live sync is down', () => {
    ws.offline = true;
    render(<SyncStatus />);
    expect(screen.getByRole('status')).toHaveTextContent('Offline');
  });
});
