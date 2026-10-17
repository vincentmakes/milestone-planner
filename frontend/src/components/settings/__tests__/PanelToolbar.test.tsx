import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/common/Button';
import { PanelToolbar } from '../PanelToolbar';
import styles from '../PanelToolbar.module.css';

describe('PanelToolbar', () => {
  it('renders the left content and the right actions in their slots', () => {
    const { container } = render(
      <PanelToolbar
        left={<span>3 skills</span>}
        right={
          <>
            <Button variant="secondary">Manage Types</Button>
            <Button>Add Skill</Button>
          </>
        }
      />
    );
    const toolbar = container.firstElementChild as HTMLElement;
    expect(toolbar).toHaveClass(styles.toolbar);
    expect(toolbar).not.toHaveClass(styles.alignEnd);

    const [left, right] = Array.from(toolbar.children) as HTMLElement[];
    expect(left).toHaveClass(styles.left);
    expect(left).toHaveTextContent('3 skills');
    expect(right).toHaveClass(styles.right);
    // Secondary actions first, the primary "Add" button last
    const buttons = Array.from(right.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Manage Types', 'Add Skill']);
  });

  it('keeps the actions on the right when there is no left content', () => {
    const { container } = render(<PanelToolbar right={<Button>Add User</Button>} />);
    const toolbar = container.firstElementChild as HTMLElement;
    expect(toolbar.children).toHaveLength(1);
    expect(toolbar.firstElementChild).toHaveClass(styles.right);
    expect(screen.getByRole('button', { name: 'Add User' })).toBeInTheDocument();
  });

  it('omits a slot whose content is false (a role-gated action)', () => {
    const canManage = false;
    const { container } = render(
      <PanelToolbar left={<span>2 types</span>} right={canManage && <Button>Add</Button>} />
    );
    const toolbar = container.firstElementChild as HTMLElement;
    expect(toolbar.children).toHaveLength(1);
    expect(toolbar.firstElementChild).toHaveClass(styles.left);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('bottom-aligns both slots with align="end" and forwards className', () => {
    const { container } = render(
      <PanelToolbar align="end" className="extra" left={<label>Site</label>} />
    );
    const toolbar = container.firstElementChild as HTMLElement;
    expect(toolbar).toHaveClass(styles.toolbar, styles.alignEnd, 'extra');
  });
});
