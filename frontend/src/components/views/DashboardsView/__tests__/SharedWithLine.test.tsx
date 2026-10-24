/**
 * SharedWithLine: everyone, private (its owner / someone else), shared with
 * chips per kind in the order roles, sites, teams, people (each named by its
 * icon), and a shared dashboard with no target left.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SharedWith } from '@/types';
import {
  EVERYONE_TEXT,
  NO_TARGET_TEXT,
  OTHER_OWNER_TEXT,
  OWNER_ONLY_TEXT,
  SharedWithLine,
} from '../SharedWithLine';
import { sharedWithNoOne } from '../sharing';

const NO_ONE: SharedWith = { roles: [], sites: [], teams: [], users: [] };

describe('SharedWithLine', () => {
  it('says a dashboard is shared with everyone', () => {
    render(<SharedWithLine dashboard={{ visibility: 'everyone', owner_id: 2, shared_with: NO_ONE }} userId={1} />);
    expect(screen.getByText(EVERYONE_TEXT)).toBeInTheDocument();
    expect(EVERYONE_TEXT).toBe('Shared with everyone');
  });

  it('says a private dashboard is only its owner’s, to its owner and to anyone else', () => {
    const { rerender } = render(
      <SharedWithLine dashboard={{ visibility: 'private', owner_id: 1, shared_with: NO_ONE }} userId={1} />
    );
    expect(screen.getByText(OWNER_ONLY_TEXT)).toBeInTheDocument();
    expect(OWNER_ONLY_TEXT).toBe('Only you (and administrators)');
    rerender(<SharedWithLine dashboard={{ visibility: 'private', owner_id: 2, shared_with: NO_ONE }} userId={1} />);
    expect(screen.getByText(OTHER_OWNER_TEXT)).toBeInTheDocument();
    rerender(<SharedWithLine dashboard={{ visibility: 'private', owner_id: null, shared_with: NO_ONE }} userId={null} />);
    expect(screen.getByText(OTHER_OWNER_TEXT)).toBeInTheDocument();
  });

  it('lists the targets as chips, each kind named by its icon', () => {
    render(
      <SharedWithLine
        dashboard={{
          visibility: 'shared',
          owner_id: 2,
          shared_with: {
            roles: [{ id: 4, name: 'Team Lead' }],
            sites: [{ id: 1, name: 'Winterthur' }],
            teams: [
              { id: 10, name: 'QA & Compliance', site_name: 'Frankfurt' },
              { id: 11, name: 'Nowhere', site_name: '' },
            ],
            users: [{ id: 6, name: 'Diana Doe' }],
          },
        }}
        userId={1}
      />
    );
    const list = screen.getByRole('list', { name: 'Shared with' });
    const chips = within(list).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual([
      'RoleTeam Lead',
      'SiteWinterthur',
      'TeamQA & Compliance · Frankfurt',
      'TeamNowhere',
      'PersonDiana Doe',
    ]);
    expect(within(chips[0]).getByRole('img', { name: 'Role' })).toBeInTheDocument();
    expect(within(chips[1]).getByRole('img', { name: 'Site' })).toBeInTheDocument();
    expect(within(chips[2]).getByRole('img', { name: 'Team' })).toBeInTheDocument();
    expect(within(chips[4]).getByRole('img', { name: 'Person' })).toBeInTheDocument();
  });

  it('says a shared dashboard has no one left', () => {
    render(<SharedWithLine dashboard={{ visibility: 'shared', owner_id: 1, shared_with: NO_ONE }} userId={1} />);
    expect(screen.getByText(NO_TARGET_TEXT)).toBeInTheDocument();
    expect(NO_TARGET_TEXT).toBe('Shared with no one left');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('tells a shared dashboard with no target left from the others', () => {
    expect(sharedWithNoOne({ visibility: 'shared', shared_with: NO_ONE })).toBe(true);
    expect(sharedWithNoOne({ visibility: 'shared', shared_with: { ...NO_ONE, users: [{ id: 1, name: 'A' }] } })).toBe(
      false
    );
    expect(sharedWithNoOne({ visibility: 'everyone', shared_with: NO_ONE })).toBe(false);
    expect(sharedWithNoOne({ visibility: 'private', shared_with: NO_ONE })).toBe(false);
  });
});
