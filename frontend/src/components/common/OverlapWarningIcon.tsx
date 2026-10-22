/**
 * Small warning triangle icon used to flag equipment that has overlapping
 * bookings or block periods: the Material warning icon in red, with an
 * accessible name.
 */

import { Icon, WarningIcon } from '@/components/common/Icon';
import styles from './OverlapWarningIcon.module.css';

interface OverlapWarningIconProps {
  size?: number;
  title?: string;
  className?: string;
}

export function OverlapWarningIcon({
  size = 14,
  title = 'Booking conflict: overlapping reservations',
  className,
}: OverlapWarningIconProps) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={className ? `${styles.warning} ${className}` : styles.warning}
    >
      <Icon icon={WarningIcon} size={size} />
    </span>
  );
}
