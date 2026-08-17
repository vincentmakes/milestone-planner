/**
 * `maxVisible` was a hard-coded constant until the header needed to shrink the
 * avatar stack on narrow screens. These tests hold the prop actually in use —
 * the header's own tests only check that it is passed.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OnlineUsers } from '../OnlineUsers';

const users = [
  ['Alice', 'Anderson'],
  ['Bob', 'Brown'],
  ['Carol', 'Clark'],
  ['Dan', 'Davis'],
  ['Eve', 'Evans'],
].map(([first, last], i) => ({
  user_id: i + 1,
  first_name: first,
  last_name: last,
  connected_at: '2026-08-17T09:00:00Z',
}));

vi.mock('@/contexts/WebSocketContext', () => ({
  useWebSocketContext: () => ({
    connectionState: 'connected',
    isConnected: true,
    onlineUsers: users,
  }),
}));

describe('OnlineUsers', () => {
  it('shows three avatars and a +N chip by default', () => {
    render(<OnlineUsers />);
    expect(screen.getByText('AA')).toBeInTheDocument();
    expect(screen.getByText('CC')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('honours a lower maxVisible, folding the rest into the chip', () => {
    render(<OnlineUsers maxVisible={1} />);
    expect(screen.getByText('AA')).toBeInTheDocument();
    expect(screen.queryByText('BB')).not.toBeInTheDocument();
    expect(screen.getByText('+4')).toBeInTheDocument();
  });
});
