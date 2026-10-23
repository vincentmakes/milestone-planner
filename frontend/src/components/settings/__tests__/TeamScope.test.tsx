/**
 * TeamScope: per site, "Whole site" (no team ids of that site) or some of the
 * site's teams. Editing one site's teams never touches another site's ids in
 * the flat selection.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamScope } from '../panels/TeamScope';
import { makeSite, makeTeam } from '@/test/factories';

const basel = makeSite({ id: 1, name: 'Basel' });
const geneva = makeSite({ id: 3, name: 'Geneva' });
const analytics = makeTeam({ id: 1, site_id: 1, name: 'Analytics' });
const processTeam = makeTeam({ id: 2, site_id: 1, name: 'Process' });
const retired = makeTeam({ id: 4, site_id: 1, name: 'Retired', active: false });
const zurichLab = makeTeam({ id: 3, site_id: 2, name: 'Zurich lab' });
const teams = [analytics, processTeam, retired, zurichLab];

describe('TeamScope', () => {
  it('renders nothing for a site without (active or ticked) teams', () => {
    const { container } = render(<TeamScope site={geneva} teams={teams} selected={[3]} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('starts on "Whole site"; switching it off shows the checklist and the open-site hint', () => {
    const onChange = vi.fn();
    render(<TeamScope site={basel} teams={teams} selected={[3]} onChange={onChange} />);
    const whole = screen.getByRole('switch', { name: 'Whole site' });
    expect(whole).toBeChecked();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();

    fireEvent.click(whole);
    expect(onChange).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Teams of Basel' });
    expect(group).toBeInTheDocument();
    // Active teams only; an inactive team is listed only while ticked
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'Analytics',
      'Process',
    ]);
    expect(screen.getByText('No team ticked — stays open to the whole site.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Process' }));
    // The other site's id is kept
    expect(onChange).toHaveBeenLastCalledWith([3, 2]);
  });

  it('starts restricted when this site has ticked teams, and lists a ticked inactive team', () => {
    render(<TeamScope site={basel} teams={teams} selected={[4, 3]} onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Whole site' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Retired (inactive)' })).toBeChecked();
    expect(screen.queryByText('No team ticked — stays open to the whole site.')).not.toBeInTheDocument();
  });

  it("switching back to whole site clears only this site's ids", () => {
    const onChange = vi.fn();
    render(<TeamScope site={basel} teams={teams} selected={[1, 3, 2]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Whole site' }));
    expect(onChange).toHaveBeenCalledWith([3]);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('names the site in the switch when several sites are in scope, and can be disabled', () => {
    render(<TeamScope site={basel} teams={teams} selected={[1]} onChange={() => {}} multiSite disabled />);
    expect(screen.getByRole('switch', { name: 'Whole site — Basel' })).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });
});
