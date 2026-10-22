/**
 * PhaseBar
 * Visual bar representing a phase on the timeline
 * Supports drag to move, resize handles, and click to edit
 * Touch-enabled for tablet/mobile devices
 */

import { memo, useRef, useCallback } from 'react';
import { armTouchGesture, getEventCoordinates, isTouchEvent, toMouseLikeEvent, NON_PASSIVE } from '@/utils/touchEvents';
import { barTextColor } from '@/utils/tags';
import styles from './PhaseBar.module.css';
import { Icon, SparklesIcon } from '@/components/common/Icon';

interface PhaseBarProps {
  left: number;
  width: number;
  color: string;
  name: string;
  isSubphase?: boolean;
  isMilestone?: boolean;
  completion?: number | null;  // 0-100 percentage
  isCriticalPath?: boolean;  // Whether this item is on the critical path
  changedBy?: string | null;  // Name of user who just changed this (for real-time indicator)
  // Interaction props
  phaseId?: number;
  projectId?: number;
  startDate?: string;
  endDate?: string;
  onDragStart?: (e: React.MouseEvent, element: HTMLElement) => void;
  onResizeStart?: (e: React.MouseEvent, edge: 'left' | 'right', element: HTMLElement) => void;
  onClick?: (e: React.MouseEvent) => void;
  // Dependency linking props
  onLinkZoneClick?: (e: React.MouseEvent, zone: 'start' | 'end') => void;
  isLinkingSource?: boolean;  // Is this the source of a pending link
  isLinkingActive?: boolean;  // Is linking mode active globally
  // Phantom sibling props
  onPhantomStart?: (zone: 'start' | 'end') => void;
}

// Minimum drag distance before we consider it a drag (vs a click)
const DRAG_THRESHOLD = 5;

export const PhaseBar = memo(function PhaseBar({
  left,
  width,
  color,
  name,
  isSubphase = false,
  isMilestone = false,
  completion = null,
  isCriticalPath = false,
  changedBy = null,
  phaseId,
  projectId,
  onDragStart,
  onResizeStart,
  onClick,
  onLinkZoneClick,
  isLinkingSource = false,
  isLinkingActive = false,
  onPhantomStart,
}: PhaseBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    hasMoved: boolean;
    originalEvent: React.MouseEvent | null;
    isTouch: boolean;
  }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    hasMoved: false,
    originalEvent: null,
    isTouch: false,
  });
  const height = isSubphase ? 16 : 20;
  // Draggable / resizable bars take touch gestures (CSS touch-action: none);
  // read-only bars leave a swipe to the browser, which scrolls the timeline.
  const isInteractive = Boolean(onDragStart || onResizeStart);
  const interactiveClass = isInteractive ? styles.interactive : '';

  const handlePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    // Check if clicking on resize handle
    const target = e.target as HTMLElement;
    if (target.classList.contains(styles.resizeHandle)) {
      return; // Let resize handle its own event
    }
    
    const isTouch = isTouchEvent(e);
    
    // Prevent default to avoid text selection. Not for a touch: React
    // registers touchstart passively, so it would be a no-op that Chrome
    // warns about (scrolling is held off by touch-action and handleMove).
    if (!isTouch) e.preventDefault();

    const coords = getEventCoordinates(e);
    
    // Convert touch to a mouse-like event for the drag / click handlers
    const mouseEvent = isTouch ? toMouseLikeEvent(e as React.TouchEvent) : (e as React.MouseEvent);
    
    // Store start position and original event
    dragStateRef.current = {
      isDragging: true,
      startX: coords.clientX,
      startY: coords.clientY,
      hasMoved: false,
      originalEvent: mouseEvent,
      isTouch,
    };
    
    // Create handlers
    const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
      const state = dragStateRef.current;
      if (!state.isDragging) return;
      
      // The finger drags the bar, not the page (CSS touch-action: none is
      // the primary guard; this covers browsers that ignore it). A read-only
      // bar must let the browser pan the timeline.
      if (isInteractive && isTouchEvent(moveEvent) && moveEvent.cancelable) {
        moveEvent.preventDefault();
      }
      
      const moveCoords = getEventCoordinates(moveEvent);
      const dx = Math.abs(moveCoords.clientX - state.startX);
      const dy = Math.abs(moveCoords.clientY - state.startY);
      
      // If moved more than threshold, start actual drag
      if (!state.hasMoved && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
        state.hasMoved = true;
        
        // Start the drag operation with the original event
        if (onDragStart && barRef.current && state.originalEvent) {
          onDragStart(state.originalEvent, barRef.current);
        }
      }
    };
    
    const removeListeners = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.removeEventListener('touchmove', handleMove, NON_PASSIVE);
      document.removeEventListener('touchend', handleUp);
      document.removeEventListener('touchcancel', handleCancel);
    };
    
    const resetState = () => {
      dragStateRef.current = {
        isDragging: false,
        startX: 0,
        startY: 0,
        hasMoved: false,
        originalEvent: null,
        isTouch: false,
      };
    };
    
    const handleUp = (upEvent: MouseEvent | TouchEvent) => {
      const state = dragStateRef.current;
      
      // A handled touchend must not also produce the synthesized mouse
      // events and click (which would open the dialog a second time).
      if (upEvent.type === 'touchend' && upEvent.cancelable) {
        upEvent.preventDefault();
      }
      
      removeListeners();
      
      // If we didn't move enough, treat as click
      if (!state.hasMoved && onClick && state.originalEvent) {
        onClick(state.originalEvent);
      }
      
      resetState();
    };
    
    // A cancelled touch (system gesture, incoming call, ...) is neither a
    // click nor a drop: release the listeners and forget the gesture.
    const handleCancel = () => {
      removeListeners();
      resetState();
    };
    
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.addEventListener('touchmove', handleMove, NON_PASSIVE);
    document.addEventListener('touchend', handleUp);
    document.addEventListener('touchcancel', handleCancel);
  }, [onDragStart, onClick, isInteractive]);

  // Resize handles: the mouse starts the resize at once; a touch is armed
  // and starts it only past the threshold, so a jittery tap resizes nothing.
  const handleResizePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent, edge: 'left' | 'right') => {
    e.stopPropagation();
    // Mark as moved to prevent click
    dragStateRef.current.hasMoved = true;
    if (!onResizeStart) return;
    
    if (isTouchEvent(e)) {
      // No preventDefault: the passive touchstart would ignore it (see above)
      armTouchGesture(e as React.TouchEvent, {
        onStart: (mouseLike) => {
          if (barRef.current) onResizeStart(mouseLike, edge, barRef.current);
        },
      });
      return;
    }
    
    e.preventDefault();
    if (barRef.current) {
      onResizeStart(e as React.MouseEvent, edge, barRef.current);
    }
  }, [onResizeStart]);

  const handleLeftResizePointerDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => handleResizePointerDown(e, 'left'),
    [handleResizePointerDown]
  );

  const handleRightResizePointerDown = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => handleResizePointerDown(e, 'right'),
    [handleResizePointerDown]
  );

  // Link zone click handlers
  const handleStartLinkZoneClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Shift+click starts phantom sibling mode
    if (e.shiftKey && onPhantomStart) {
      onPhantomStart('start');
      return;
    }
    
    if (onLinkZoneClick) {
      onLinkZoneClick(e, 'start');
    }
  }, [onLinkZoneClick, onPhantomStart]);

  const handleEndLinkZoneClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Shift+click starts phantom sibling mode
    if (e.shiftKey && onPhantomStart) {
      onPhantomStart('end');
      return;
    }
    
    if (onLinkZoneClick) {
      onLinkZoneClick(e, 'end');
    }
  }, [onLinkZoneClick, onPhantomStart]);

  // Milestone diamond style
  if (isMilestone) {
    // Use appropriate data attribute based on whether this is a phase or subphase
    const dataAttrs = isSubphase 
      ? { 'data-subphase-id': phaseId, 'data-project-id': projectId }
      : { 'data-phase-id': phaseId, 'data-project-id': projectId };
    
    return (
      <div
        ref={barRef}
        className={`${styles.milestone} ${interactiveClass} ${isSubphase ? styles.subphase : ''} ${isLinkingSource ? styles.linkingSource : ''} ${isCriticalPath ? styles.criticalPath : ''} ${changedBy ? styles.recentlyChanged : ''}`}
        style={{
          left: left + width / 2 - 12, // Center on the date
        }}
        title={isCriticalPath ? `${name} (Critical Path)` : name}
        onMouseDown={handlePointerDown}
        onTouchStart={handlePointerDown}
        {...dataAttrs}
      >
        {/* Start link zone */}
        {onLinkZoneClick && (
          <div 
            className={`${styles.linkZone} ${styles.start} ${styles.milestoneZone} ${isLinkingActive ? styles.linkingActive : ''}`}
            onClick={handleStartLinkZoneClick}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            title="Click to start linking (SS or SF)"
          />
        )}
        
        <div 
          className={`${styles.milestoneDiamond} ${isCriticalPath ? styles.criticalPathDiamond : ''}`}
          style={{ backgroundColor: color }}
        />
        {name && <span className={styles.milestoneLabel}>{name}</span>}
        
        {/* Changed by indicator */}
        {changedBy && (
          <span className={styles.changedByBadge}>
            <Icon icon={SparklesIcon} size={10} /> {changedBy}
          </span>
        )}
        
        {/* End link zone */}
        {onLinkZoneClick && (
          <div 
            className={`${styles.linkZone} ${styles.end} ${styles.milestoneZone} ${isLinkingActive ? styles.linkingActive : ''}`}
            onClick={handleEndLinkZoneClick}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            title="Click to start linking (FS or FF)"
          />
        )}
      </div>
    );
  }

  // Calculate completion bar width
  const hasCompletion = completion !== null && completion >= 0;
  const completionWidth = hasCompletion ? Math.min(100, Math.max(0, completion)) : 0;

  // Use appropriate data attribute based on whether this is a phase or subphase
  const dataAttrs = isSubphase 
    ? { 'data-subphase-id': phaseId, 'data-project-id': projectId }
    : { 'data-phase-id': phaseId, 'data-project-id': projectId };

  // Light custom colours get dark text (same rule as ProjectBar / barTextColor)
  const textColor = barTextColor(color);
  const darkTextClass = textColor === '#111827' ? styles.darkText : '';

  // Build title with completion and critical path info
  let barTitle = name;
  if (hasCompletion) barTitle += ` (${completion}%)`;
  if (isCriticalPath) barTitle += ' - Critical Path';

  return (
    <div
      ref={barRef}
      className={`${styles.bar} ${interactiveClass} ${isSubphase ? styles.subphase : ''} ${isLinkingSource ? styles.linkingSource : ''} ${isCriticalPath ? styles.criticalPath : ''} ${changedBy ? styles.recentlyChanged : ''} ${darkTextClass}`}
      style={{
        left,
        width,
        height,
        backgroundColor: color,
        color: textColor,
      }}
      title={barTitle}
      onMouseDown={handlePointerDown}
      onTouchStart={handlePointerDown}
      {...dataAttrs}
    >
      {/* Completion bar */}
      {hasCompletion && completionWidth > 0 && (
        <div 
          className={styles.completionBar}
          style={{ width: `${completionWidth}%` }}
        />
      )}
      
      {/* Start link zone */}
      {onLinkZoneClick && (
        <div 
          className={`${styles.linkZone} ${styles.start} ${isLinkingActive ? styles.linkingActive : ''}`}
          onClick={handleStartLinkZoneClick}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          title="Click to start linking (SS or SF)"
        />
      )}
      
      {/* Left resize handle - enabled for both phases and subphases */}
      {!isMilestone && onResizeStart && (
        <div 
          className={`${styles.resizeHandle} ${styles.left}`}
          onMouseDown={handleLeftResizePointerDown}
          onTouchStart={handleLeftResizePointerDown}
        />
      )}
      
      {/* Label */}
      {width > 40 && (
        <span className={styles.label}>
          {name}
        </span>
      )}
      
      {/* Changed by indicator */}
      {changedBy && (
        <span className={styles.changedByBadge}>
          <Icon icon={SparklesIcon} size={10} /> {changedBy}
        </span>
      )}
      
      {/* Right resize handle - enabled for both phases and subphases */}
      {!isMilestone && onResizeStart && (
        <div 
          className={`${styles.resizeHandle} ${styles.right}`}
          onMouseDown={handleRightResizePointerDown}
          onTouchStart={handleRightResizePointerDown}
        />
      )}
      
      {/* End link zone */}
      {onLinkZoneClick && (
        <div 
          className={`${styles.linkZone} ${styles.end} ${isLinkingActive ? styles.linkingActive : ''}`}
          onClick={handleEndLinkZoneClick}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          title="Click to start linking (FS or FF)"
        />
      )}
    </div>
  );
});
