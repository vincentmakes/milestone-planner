/**
 * Small warning triangle icon used to flag equipment that has overlapping
 * bookings or block periods. Inline SVG so it inherits color and is easy to
 * size with `width` / `height`.
 */

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
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--accent-red)' }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
  );
}
