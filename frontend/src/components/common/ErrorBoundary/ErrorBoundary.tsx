/**
 * ErrorBoundary — keeps a failing view from taking the whole app down.
 *
 * A render error below it (or a lazy chunk that fails to load) shows a
 * `Notice` with "This view could not be shown." and a **Retry** button that
 * remounts the children (a `key` bump). `fallback` replaces that content
 * when a caller needs its own; it receives the retry function. The error is
 * logged, never shown (it may carry internals).
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Notice } from '@/components/common/Notice';
import { Button } from '@/components/common/Button';
import { Icon, RefreshIcon } from '@/components/common/Icon';
import styles from './ErrorBoundary.module.css';

export const ERROR_BOUNDARY_MESSAGE = 'This view could not be shown.';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom content shown instead of the children after an error */
  fallback?: (retry: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
  /** Bumped by Retry: a new key remounts the children from scratch */
  attempt: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] A view failed to render', error, info.componentStack);
  }

  retry = (): void => {
    this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
  };

  render(): ReactNode {
    if (this.state.failed) {
      if (this.props.fallback) return this.props.fallback(this.retry);
      return <ErrorBoundaryFallback onRetry={this.retry} />;
    }
    return <ErrorBoundaryKey key={this.state.attempt}>{this.props.children}</ErrorBoundaryKey>;
  }
}

/** A keyed wrapper, so Retry remounts the whole subtree. */
function ErrorBoundaryKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** The default content after an error: the message and Retry. */
export function ErrorBoundaryFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={styles.fallback}>
      <Notice tone="error">{ERROR_BOUNDARY_MESSAGE}</Notice>
      <Button variant="secondary" icon={<Icon icon={RefreshIcon} />} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
