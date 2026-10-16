import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'icon';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  iconPosition?: 'left' | 'right';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      iconPosition = 'left',
      children,
      className,
      disabled,
      ...props
    },
    ref
  ) => {
    const classes = [
      styles.button,
      // The icon-only variant uses its own class so it can never collide
      // with the icon wrapper (`.iconSlot`).
      variant === 'icon' ? styles.iconOnly : styles[variant],
      styles[size],
      loading && styles.loading,
      disabled && styles.disabled,
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <button
        ref={ref}
        className={classes}
        disabled={loading || disabled}
        {...props}
      >
        {loading && <span className={styles.spinner} />}
        {!loading && icon && iconPosition === 'left' && (
          <span className={styles.iconSlot}>{icon}</span>
        )}
        {children && <span className={styles.content}>{children}</span>}
        {!loading && icon && iconPosition === 'right' && (
          <span className={styles.iconSlot}>{icon}</span>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
