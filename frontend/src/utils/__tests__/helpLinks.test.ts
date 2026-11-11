/**
 * helpLinks: Help opens one address as it is; *How calculations work* opens
 * the custom address when one is set, else the public calculations chapter,
 * a page the manual has.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CALCULATIONS_HELP_PAGE, calculationsHelpUrl, DEFAULT_HELP_URL } from '../helpLinks';

describe('calculationsHelpUrl', () => {
  it('opens the public calculations chapter without a custom address', () => {
    expect(calculationsHelpUrl(null)).toBe('https://docs-milestone.verdet.me/user-guide/dashboards/#calculated-widgets');
  });

  it('opens a custom address as it is, nothing appended', () => {
    const pdf = 'https://contoso.sharepoint.com/:b:/r/sites/Lab/Manual.pdf?csf=1&web=1#page=4';
    expect(calculationsHelpUrl(pdf)).toBe(pdf);
    expect(calculationsHelpUrl('https://intranet.example/docs')).toBe('https://intranet.example/docs');
  });

  it('points at a page and a heading the public manual has', () => {
    expect(DEFAULT_HELP_URL).toBe('https://docs-milestone.verdet.me/');
    const [page, anchor] = CALCULATIONS_HELP_PAGE.split('#');
    const docs = resolve(__dirname, '../../../../docs');
    expect(existsSync(resolve(docs, `${page.slice(0, -1)}.md`)), page).toBe(true);
    expect(anchor).toBe('calculated-widgets');
  });
});
