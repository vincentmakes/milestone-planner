/**
 * SSOTestResult: the summary, one row per check with its status mark, the
 * AADSTS code after the name when Microsoft gave one, and the message.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SSOTestResult } from '../SSOTestResult';
import type { SSOTestResult as Result } from '@/api/endpoints/sso';

const RESULT: Result = {
  credentialsOk: false,
  summary: 'Microsoft rejected the configuration. See below.',
  checks: [
    { name: 'Directory (tenant) ID', status: 'pass', message: 'Looks like a valid identifier.' },
    { name: 'Client credentials', status: 'fail', message: 'Invalid secret', code: 'AADSTS7000215' },
    { name: 'Outbound network', status: 'warn', message: 'Proxy settings ignored' },
    { name: 'Microsoft sign-in', status: 'manual', message: 'Confirm the Web platform', code: null },
  ],
};

/** The mark of a check: name → text block → row, whose first child holds the svg. */
const mark = (name: string) => {
  const row = screen.getByText(name).parentElement?.parentElement;
  const span = row?.firstElementChild;
  return { span, icon: span?.querySelector('svg')?.getAttribute('data-testid') };
};

describe('SSOTestResult', () => {
  it('announces the summary and every check politely', () => {
    render(<SSOTestResult result={RESULT} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Microsoft rejected the configuration. See below.');
    expect(screen.getByText('Looks like a valid identifier.')).toBeInTheDocument();
    expect(screen.getByText('Confirm the Web platform')).toBeInTheDocument();
  });

  it('marks each of the four statuses with its own icon and colour class', () => {
    render(<SSOTestResult result={RESULT} />);
    const marks = RESULT.checks.map((c) => mark(c.name));
    expect(marks.map((m) => m.icon)).toEqual([
      'CheckCircleOutlinedIcon',
      'CancelOutlinedIcon',
      'WarningAmberOutlinedIcon',
      'HelpOutlineIcon',
    ]);
    expect(marks.map((m) => m.span?.className)).toEqual([
      expect.stringMatching(/pass/),
      expect.stringMatching(/fail/),
      expect.stringMatching(/warn/),
      expect.stringMatching(/mark/),
    ]);
    marks.forEach((m) => expect(m.span).toHaveAttribute('aria-hidden', 'true'));
  });

  it('adds the AADSTS code after the name, only when there is one', () => {
    render(<SSOTestResult result={RESULT} />);
    expect(screen.getByText('(AADSTS7000215)', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Microsoft sign-in').textContent).toBe('Microsoft sign-in');
    expect(screen.getByText('Directory (tenant) ID').querySelector('span')).toBeNull();
  });

  it('falls back to the question mark for an unknown status and keeps a class name', () => {
    const odd = { ...RESULT, checks: [{ name: 'Future', status: 'other', message: 'm' }] } as unknown as Result;
    const { container } = render(<SSOTestResult result={odd} className="extra" />);
    expect(mark('Future').icon).toBe('HelpOutlineIcon');
    expect(container.firstElementChild).toHaveClass('extra');
  });
});
