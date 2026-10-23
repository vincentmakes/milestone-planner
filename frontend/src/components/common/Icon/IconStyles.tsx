import type { ReactNode } from 'react';
import { CacheProvider } from '@emotion/react';
import { iconStyleCache } from './iconStyleCache';

/** Wraps the app once (`main.tsx`) so the icons' base rules come first. */
export function IconStyles({ children }: { children: ReactNode }) {
  return <CacheProvider value={iconStyleCache}>{children}</CacheProvider>;
}
