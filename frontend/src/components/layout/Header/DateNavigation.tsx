/**
 * DateNavigation
 * Controls for navigating the timeline (prev/next/today)
 */

import { useViewStore } from '@/stores/viewStore';
import { useUIStore } from '@/stores/uiStore';
import { addWeeks, addMonths, startOfWeek, startOfQuarter } from 'date-fns';
import styles from './DateNavigation.module.css';
import { Icon, ChevronRightIcon, BackIcon } from '@/components/common/Icon';

interface DateNavigationProps {
  /** Abbreviates the period ("Aug 2026" rather than "August 2026") when the
   *  header is short of room. */
  shortLabel?: boolean;
}

export function DateNavigation({ shortLabel = false }: DateNavigationProps) {
  const viewMode = useViewStore((s) => s.viewMode);
  const currentDate = useViewStore((s) => s.currentDate);
  const setCurrentDate = useViewStore((s) => s.setCurrentDate);
  const triggerScrollToToday = useUIStore((s) => s.triggerScrollToToday);

  // Navigate to previous/next period
  const navigate = (direction: -1 | 1) => {
    let newDate: Date;
    
    switch (viewMode) {
      case 'week':
        newDate = addWeeks(currentDate, direction);
        break;
      case 'month':
        newDate = addMonths(currentDate, direction);
        break;
      case 'quarter':
        newDate = addMonths(currentDate, direction * 3);
        break;
      case 'year':
        newDate = addMonths(currentDate, direction * 12);
        break;
      default:
        newDate = addMonths(currentDate, direction);
    }
    
    setCurrentDate(newDate);
  };

  // Go to today - also triggers timeline scroll
  const goToToday = () => {
    setCurrentDate(new Date());
    // Trigger scroll to today marker in timeline
    triggerScrollToToday();
  };

  // Format the current period label using browser locale
  const getPeriodLabel = (): string => {
    const monthYearFormatter = new Intl.DateTimeFormat(undefined, {
      month: shortLabel ? 'short' : 'long',
      year: 'numeric',
    });
    const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const yearFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric' });
    
    switch (viewMode) {
      case 'week': {
        const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
        return dateFormatter.format(weekStart);
      }
      case 'month':
        return monthYearFormatter.format(currentDate);
      case 'quarter': {
        const qStart = startOfQuarter(currentDate);
        const quarter = Math.floor(qStart.getMonth() / 3) + 1;
        return `Q${quarter} ${yearFormatter.format(qStart)}`;
      }
      case 'year':
        return yearFormatter.format(currentDate);
      default:
        return monthYearFormatter.format(currentDate);
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.navigation}>
        <button
          className={styles.navButton}
          onClick={() => navigate(-1)}
          title="Previous period"
        >
          <Icon icon={BackIcon} size={16} />
        </button>
        
        <span className={styles.periodLabel}>{getPeriodLabel()}</span>
        
        <button
          className={styles.navButton}
          onClick={() => navigate(1)}
          title="Next period"
        >
          <Icon icon={ChevronRightIcon} size={16} />
        </button>
      </div>
      
      <button
        className={styles.todayButton}
        onClick={goToToday}
        title="Go to today"
      >
        Today
      </button>
    </div>
  );
}
