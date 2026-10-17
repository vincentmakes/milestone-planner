/**
 * Small stroke icons used by the Settings hub panels (and the admin portal).
 *
 * Pass them to the shared `Button` through its `icon` prop — the button
 * sizes the svg (14 px in md, 12 px in sm) and colours it with
 * `currentColor`. Every icon is `aria-hidden`, so a button's accessible
 * name is its label alone.
 */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  'aria-hidden': true,
} as const;

interface IconProps {
  size?: number;
}

export function EditIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function TrashIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/** Broken chain link: remove an item from some sites without deleting it */
export function UnlinkIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M18.84 12.25l1.72-1.71a4.95 4.95 0 0 0-7-7l-1.71 1.72" />
      <path d="M5.17 11.75l-1.71 1.71a4.95 4.95 0 0 0 7 7l1.71-1.71" />
      <line x1="8" y1="2" x2="8" y2="5" />
      <line x1="2" y1="8" x2="5" y2="8" />
      <line x1="16" y1="19" x2="16" y2="22" />
      <line x1="19" y1="16" x2="22" y2="16" />
    </svg>
  );
}

export function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function DownloadIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function UploadIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export function RefreshIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function BackIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/** Gear: open a related management section ("Manage Skills", "Manage Types") */
export function GearIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function LogoutIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function DragHandleIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <line x1="8" y1="6" x2="16" y2="6" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="18" x2="16" y2="18" />
    </svg>
  );
}

/** Confirm an inline add row */
export function CheckIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Cancel an inline add row, dismiss */
export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/** An item that is active (filled check in a circle) */
export function CheckCircleIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

/** An item that is inactive (empty circle); also the placeholder while something runs */
export function CircleIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} {...base}>
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}
