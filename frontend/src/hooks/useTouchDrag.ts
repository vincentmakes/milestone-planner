/**
 * useTouchDrag Hook
 * Converts touch events to mouse-like events for drag operations on touch devices
 */

import { useCallback, useRef, useEffect } from 'react';

interface TouchDragOptions {
  onDragStart?: (x: number, y: number, element: HTMLElement) => void;
  onDragMove?: (x: number, y: number, deltaX: number, deltaY: number) => void;
  onDragEnd?: () => void;
  threshold?: number; // Minimum movement before drag starts
}

interface TouchState {
  isDragging: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  element: HTMLElement | null;
  touchId: number | null;
}

export function useTouchDrag(options: TouchDragOptions = {}) {
  const { onDragStart, onDragMove, onDragEnd, threshold = 5 } = options;
  
  const stateRef = useRef<TouchState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    element: null,
    touchId: null,
  });

  const handleTouchStart = useCallback((e: React.TouchEvent, element?: HTMLElement) => {
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    const target = element || (e.target as HTMLElement);
    
    stateRef.current = {
      isDragging: false,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      element: target,
      touchId: touch.identifier,
    };
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    const state = stateRef.current;
    if (state.touchId === null) return;
    
    const touch = Array.from(e.touches).find(t => t.identifier === state.touchId);
    if (!touch) return;
    
    const deltaX = touch.clientX - state.lastX;
    const deltaY = touch.clientY - state.lastY;
    const totalDeltaX = touch.clientX - state.startX;
    const totalDeltaY = touch.clientY - state.startY;
    
    // Check if we should start dragging
    if (!state.isDragging) {
      const distance = Math.sqrt(totalDeltaX ** 2 + totalDeltaY ** 2);
      if (distance >= threshold) {
        state.isDragging = true;
        if (onDragStart && state.element) {
          onDragStart(state.startX, state.startY, state.element);
        }
        // Prevent scrolling when dragging
        e.preventDefault();
      }
    }
    
    if (state.isDragging) {
      e.preventDefault();
      if (onDragMove) {
        onDragMove(touch.clientX, touch.clientY, deltaX, deltaY);
      }
    }
    
    state.lastX = touch.clientX;
    state.lastY = touch.clientY;
  }, [onDragStart, onDragMove, threshold]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    const state = stateRef.current;
    if (state.touchId === null) return;
    
    // Check if our touch ended
    const touch = Array.from(e.changedTouches).find(t => t.identifier === state.touchId);
    if (!touch) return;
    
    if (state.isDragging && onDragEnd) {
      onDragEnd();
    }
    
    stateRef.current = {
      isDragging: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      element: null,
      touchId: null,
    };
  }, [onDragEnd]);

  // Add global touch listeners
  useEffect(() => {
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);
    
    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleTouchMove, handleTouchEnd]);

  return {
    handleTouchStart,
    isDragging: stateRef.current.isDragging,
  };
}

/**
 * Helper to create a synthetic mouse event from touch coordinates
 * This allows existing mouse-based handlers to work with touch
 */
export function createSyntheticMouseEvent(
  type: 'mousedown' | 'mousemove' | 'mouseup',
  x: number,
  y: number,
  _target: HTMLElement
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    view: window,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
  });
}

/**
 * Check if the device supports touch
 */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
