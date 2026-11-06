/**
 * Pagination — numbered paging: First / Previous / Next / Last around
 * "Page {n} of {m}" (the audit log).
 *
 * A `nav` named "Pagination" of icon-only ghost `Button`s, each with an
 * `aria-label`; First and Previous are disabled on the first page, Next and
 * Last on the last. `onPageChange` gets the target page (1-based). The caller
 * owns the page size (a "Per page" `Select` next to it).
 */

import { Button } from '@/components/common/Button';
import { Icon, BackIcon, ChevronRightIcon, FirstPageIcon, LastPageIcon } from '@/components/common/Icon';
import styles from './Pagination.module.css';

export interface PaginationProps {
  /** The current page, 1-based */
  page: number;
  /** How many pages there are (at least 1) */
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Disable every button (e.g. while a page loads) */
  disabled?: boolean;
  className?: string;
}

export function Pagination({ page, pageCount, onPageChange, disabled = false, className }: PaginationProps) {
  const last = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), last);
  const atStart = disabled || current <= 1;
  const atEnd = disabled || current >= last;

  return (
    <nav className={[styles.pagination, className].filter(Boolean).join(' ')} aria-label="Pagination">
      <Button
        variant="ghost"
        icon={<Icon icon={FirstPageIcon} />}
        aria-label="First page"
        title="First page"
        disabled={atStart}
        onClick={() => onPageChange(1)}
      />
      <Button
        variant="ghost"
        icon={<Icon icon={BackIcon} />}
        aria-label="Previous page"
        title="Previous page"
        disabled={atStart}
        onClick={() => onPageChange(current - 1)}
      />
      <span className={styles.status}>
        Page {current} of {last}
      </span>
      <Button
        variant="ghost"
        icon={<Icon icon={ChevronRightIcon} />}
        aria-label="Next page"
        title="Next page"
        disabled={atEnd}
        onClick={() => onPageChange(current + 1)}
      />
      <Button
        variant="ghost"
        icon={<Icon icon={LastPageIcon} />}
        aria-label="Last page"
        title="Last page"
        disabled={atEnd}
        onClick={() => onPageChange(last)}
      />
    </nav>
  );
}
