import type SvgIcon from '@mui/material/SvgIcon';

/** A Material icon component (one of the exports of `./icons`). */
export type IconComponent = typeof SvgIcon;

export interface IconProps {
  /** The icon to draw, from `./icons` */
  icon: IconComponent;
  /** Width and height in px (default 16) */
  size?: number;
  className?: string;
  /**
   * An accessible name. Without one the icon is decorative (`aria-hidden`),
   * so a button's accessible name stays its label alone.
   */
  title?: string;
}

/**
 * Renders one app icon at `size` px in the current text colour.
 *
 * The size is the svg's font size (Material icons are 1em square), so a
 * stylesheet that sets the svg's `width` / `height` — the shared `Button`'s
 * icon slot, a row's `.chevron` — still wins.
 */
export function Icon({ icon: Component, size = 16, className, title }: IconProps) {
  return (
    <Component
      className={className}
      fontSize="inherit"
      style={{ fontSize: size }}
      titleAccess={title}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    />
  );
}
