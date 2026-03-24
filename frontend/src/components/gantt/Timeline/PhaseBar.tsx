/**
 * PhaseBar
 * Visual bar representing a phase on the timeline
 * Supports drag to move, resize handles, and click to edit
 * Touch-enabled for tablet/mobile devices
 */

import { memo, useRef, useCallback } from 'react';
import styles from './PhaseBar.module.css';

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

// Get coordinates from mouse or touch event
function getEventCoordinates(e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent): { clientX: number; clientY: number } {
  if ('touches' in e && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if ('changedTouches' in e && e.changedTouches.length > 0) {
    return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
  }
  return { clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY };
}

// Create a synthetic mouse event from touch event for compatibility
function createSyntheticMouseEvent(e: React.TouchEvent, type: string = 'mousedown'): React.MouseEvent {
  const touch = e.touches[0] || e.changedTouches[0];
  return {
    ...e,
    type,
    clientX: touch.clientX,
    clientY: touch.clientY,
    screenX: touch.screenX,
    screenY: touch.screenY,
    pageX: touch.pageX,
    pageY: touch.pageY,
    button: 0,
    buttons: 1,
  } as unknown as React.MouseEvent;
}

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

  const handlePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    // Check if clicking on resize handle
    const target = e.target as HTMLElement;
    if (target.classList.contains(styles.resizeHandle)) {
      return; // Let resize handle its own event
    }
    
    // Prevent default to avoid text selection / scrolling
    e.preventDefault();
    
    const isTouch = 'touches' in e;
    const coords = getEventCoordinates(e);
    
    // Convert touch to synthetic mouse event for compatibility
    const mouseEvent = isTouch ? createSyntheticMouseEvent(e as React.TouchEvent) : (e as React.MouseEvent);
    
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
      
      const moveCoords = getEventCoordinates(moveEvent);
      const dx = Math.abs(moveCoords.clientX - state.startX);
      const dy = Math.abs(moveCoords.clientY - state.startY);
      
      // If moved more than threshold, start actual drag
      if (!state.hasMoved && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
        state.hasMoved = true;
        
        // Prevent scrolling on touch devices during drag
        if ('touches' in moveEvent) {
          moveEvent.preventDefault();
        }
        
        // Start the drag operation with the original event
        if (onDragStart && barRef.current && state.originalEvent) {
          onDragStart(state.originalEvent, barRef.current);
        }
      }
    };
    
    const handleUp = () => {
      const state = dragStateRef.current;
      
      // Clean up
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleUp);
      document.removeEventListener('touchcancel', handleUp);
      
      // If we didn't move enough, treat as click
      if (!state.hasMoved && onClick && state.originalEvent) {
        onClick(state.originalEvent);
      }
      
      // Reset state
      dragStateRef.current = {
        isDragging: false,
        startX: 0,
        startY: 0,
        hasMoved: false,
        originalEvent: null,
        isTouch: false,
      };
    };
    
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleUp);
    document.addEventListener('touchcancel', handleUp);
  }, [onDragStart, onClick]);

  const handleLeftResizePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Mark as moved to prevent click
    dragStateRef.current.hasMoved = true;
    
    const isTouch = 'touches' in e;
    const mouseEvent = isTouch ? createSyntheticMouseEvent(e as React.TouchEvent) : (e as React.MouseEvent);
    
    if (onResizeStart && barRef.current) {
      onResizeStart(mouseEvent, 'left', barRef.current);
    }
  }, [onResizeStart]);

  const handleRightResizePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Mark as moved to prevent click
    dragStateRef.current.hasMoved = true;
    
    const isTouch = 'touches' in e;
    const mouseEvent = isTouch ? createSyntheticMouseEvent(e as React.TouchEvent) : (e as React.MouseEvent);
    
    if (onResizeStart && barRef.current) {
      onResizeStart(mouseEvent, 'right', barRef.current);
    }
  }, [onResizeStart]);

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
        className={`${styles.milestone} ${isSubphase ? styles.subphase : ''} ${isLinkingSource ? styles.linkingSource : ''} ${isCriticalPath ? styles.criticalPath : ''} ${changedBy ? styles.recentlyChanged : ''}`}
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
          <span className={styles.changedByBadge}>✨ {changedBy}</span>
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

  // Build title with completion and critical path info
  let barTitle = name;
  if (hasCompletion) barTitle += ` (${completion}%)`;
  if (isCriticalPath) barTitle += ' - Critical Path';

  return (
    <div
      ref={barRef}
      className={`${styles.bar} ${isSubphase ? styles.subphase : ''} ${isLinkingSource ? styles.linkingSource : ''} ${isCriticalPath ? styles.criticalPath : ''} ${changedBy ? styles.recentlyChanged : ''}`}
      style={{
        left,
        width,
        height,
        backgroundColor: color,
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
        <span className={styles.changedByBadge}>✨ {changedBy}</span>
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
