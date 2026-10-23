/**
 * PermissionMatrix: the catalogue grouped by domain, one radiogroup of mode
 * chips per permission (named after it). "Needs approval" exists only on the
 * approvable own-booking keys; locked keys and a read-only matrix (the admin
 * role) cannot change; arrow keys move between a row's chips.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { PermissionMatrix } from '../panels/PermissionMatrix';
import { makeCatalogue } from '@/test/permissionFixtures';
import type { PermissionMatrix as Matrix } from '@/types';

const { groups } = makeCatalogue();
const base: Matrix = { 'projects.view': 'allow', 'assignments.self_create': 'approval' };

const chips = (label: string) => within(screen.getByRole('radiogroup', { name: label })).getAllByRole('radio');
const checked = (label: string) =>
  within(screen.getByRole('radiogroup', { name: label }))
    .getAllByRole('radio')
    .find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;

describe('PermissionMatrix', () => {
  it('groups the permissions by domain, one named radiogroup each', () => {
    render(<PermissionMatrix groups={groups} value={base} onChange={() => {}} />);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Projects',
      'Assignments',
      'Administration',
    ]);
    expect(screen.getAllByRole('radiogroup')).toHaveLength(5);
    expect(screen.getByRole('radiogroup', { name: 'Create projects' })).toHaveAccessibleDescription('Create projects.');
  });

  it('shows the current mode of every key, missing = Deny', () => {
    render(<PermissionMatrix groups={groups} value={base} onChange={() => {}} />);
    expect(checked('View projects')).toBe('Allow');
    expect(checked('Create projects')).toBe('Deny');
    expect(checked('Book own time')).toBe('Needs approval');
  });

  it('offers "Needs approval" only on approvable keys', () => {
    render(<PermissionMatrix groups={groups} value={base} onChange={() => {}} />);
    expect(chips('Book own time').map((c) => c.textContent)).toEqual(['Allow', 'Needs approval', 'Deny']);
    expect(chips("Manage others' bookings").map((c) => c.textContent)).toEqual(['Allow', 'Deny']);
  });

  it('reports the new matrix on a chip click (Deny drops the key)', () => {
    const onChange = vi.fn();
    render(<PermissionMatrix groups={groups} value={base} onChange={onChange} />);

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Create projects' })).getByRole('radio', { name: 'Allow' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...base, 'projects.create': 'allow' });

    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Book own time' })).getByRole('radio', { name: 'Deny' }));
    expect(onChange).toHaveBeenLastCalledWith({ 'projects.view': 'allow' });

    // Clicking the current mode reports nothing
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'View projects' })).getByRole('radio', { name: 'Allow' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('greys out locked keys and keeps them as they are', () => {
    const onChange = vi.fn();
    render(<PermissionMatrix groups={groups} value={base} onChange={onChange} />);
    for (const label of ['View projects', 'Manage roles']) {
      for (const chip of chips(label)) expect(chip).toBeDisabled();
      expect(screen.getByRole('radiogroup', { name: label }).closest('[data-locked]')).toHaveAttribute('data-locked', 'true');
    }
    expect(checked('Manage roles')).toBe('Deny');
    expect(within(screen.getByRole('radiogroup', { name: 'Manage roles' }).closest('[data-locked]') as HTMLElement).getByText('Locked')).toBeInTheDocument();
    fireEvent.click(chips('Manage roles')[0]);
    expect(onChange).not.toHaveBeenCalled();
    // An unlocked row is not marked
    expect(screen.getByRole('radiogroup', { name: 'Create projects' }).closest('[data-locked]')).toHaveAttribute('data-locked', 'false');
  });

  it('disables every chip when read-only', () => {
    render(<PermissionMatrix groups={groups} value={base} readOnly />);
    for (const chip of screen.getAllByRole('radio')) expect(chip).toBeDisabled();
  });

  it('moves the choice with the arrow keys, one tab stop per row', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PermissionMatrix groups={groups} value={base} onChange={onChange} />);
    const [allow, approval, deny] = chips('Book own time');
    expect([allow, approval, deny].map((c) => c.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(approval, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ 'projects.view': 'allow' });
    rerender(<PermissionMatrix groups={groups} value={{ 'projects.view': 'allow' }} onChange={onChange} />);
    expect(document.activeElement).toBe(chips('Book own time')[2]);

    // Wraps around, and ArrowLeft goes back
    fireEvent.keyDown(chips('Book own time')[2], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ 'projects.view': 'allow', 'assignments.self_create': 'allow' });
    fireEvent.keyDown(chips('Book own time')[2], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith({ 'projects.view': 'allow', 'assignments.self_create': 'approval' });
    // Other keys do nothing
    fireEvent.keyDown(chips('Book own time')[2], { key: 'a' });
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
