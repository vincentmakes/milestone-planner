import { useState, useRef, ReactNode, useCallback } from 'react';
import { createPortal } from 'react-dom';
import styles from './Tooltip.module.css';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 200,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const showTooltip = useCallback(() => {
    timeoutRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = position === 'top' ? rect.top : rect.bottom;
        setCoords({ x, y });
        setIsVisible(true);
      }
    }, delay);
  }, [delay, position]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
  }, []);

  const tooltipClasses = [styles.tooltip, styles[position]].join(' ');

  const tooltipStyle: React.CSSProperties = {
    left: coords.x,
    top: position === 'top' ? coords.y : undefined,
    bottom: position === 'bottom' ? window.innerHeight - coords.y : undefined,
  };

  return (
    <>
      <div
        ref={triggerRef}
        className={styles.trigger}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children}
      </div>
      {isVisible &&
        createPortal(
          <div className={tooltipClasses} style={tooltipStyle} role="tooltip">
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
