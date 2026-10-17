// Re-export all stores from a single entry point
import { useAppStore } from './appStore';
import { useUIStore } from './uiStore';
import { useViewStore } from './viewStore';
import { useUndoStore } from './undoStore';
import { useWhatIfStore } from './whatIfStore';
import { useCustomColumnStore } from './customColumnStore';
import { useNotificationStore } from './notificationStore';
import { useConfirmStore } from './confirmStore';

export { useAppStore, selectStaffSiteIds, selectAbsenceTypesById, selectCanManageResources } from './appStore';
export { useUIStore } from './uiStore';
export { useUndoStore } from './undoStore';
export { useViewStore } from './viewStore';
export { useWhatIfStore } from './whatIfStore';
export type { WhatIfOperation } from './whatIfStore';
export { useCustomColumnStore } from './customColumnStore';
export { useNotificationStore } from './notificationStore';
export { useConfirmStore } from './confirmStore';
export type { ConfirmOptions } from './confirmStore';

/**
 * <body> classes set by in-progress gestures/modes (phantom sibling, resource
 * and Kanban drags, What-If). They live outside the stores, so a logout or a
 * 401 mid-gesture would otherwise leave the styling on the login screen and
 * the next session (App re-syncs `what-if-mode` from whatIfStore anyway).
 */
const TRANSIENT_BODY_CLASSES = [
  'phantom-sibling-mode',
  'resource-dragging',
  'kanban-dragging',
  'what-if-mode',
];

/**
 * Forget everything that belongs to the signed-in tenant user (logout, or a
 * session that expired/was revoked): domain data, the What-If sandbox and its
 * queue, the undo history, the notification inbox, custom-column data, any
 * pending confirmation (answered `false`) and any open modal or in-progress
 * gesture (including its <body> class). Without this, the next user to sign in
 * on the same tab would inherit (and could Apply) the previous user's queue.
 *
 * Per-browser preferences survive: the remembered site, the view settings
 * (viewStore) and custom-column visibility. The admin portal (adminStore) has
 * its own session and is left alone.
 *
 * Leaves `isAuthChecking: true` like appStore.reset(); callers that already
 * know the answer (see expireSession) set it themselves.
 */
export function resetAllStores(): void {
  const persistedSiteId = useAppStore.getState()._persistedSiteId;
  useAppStore.getState().reset();
  useAppStore.setState({ _persistedSiteId: persistedSiteId });

  useWhatIfStore.getState().reset();
  useUndoStore.getState().clear();
  useNotificationStore.getState().reset();
  useCustomColumnStore.setState({
    customColumns: [],
    customColumnValues: {},
    customColumnFilters: {},
  });
  // Answer any open confirmation `false`: the caller must not act for a
  // session that is gone (the dialog unmounts with the empty queue).
  useConfirmStore.getState().reset();
  useUIStore.setState(useUIStore.getInitialState());
  // The place in the timeline is per session, not per browser: the next
  // sign-in (or the same person after a session expiry) opens on today, as a
  // reload does. Every other view setting survives.
  useViewStore.getState().resetTimelinePosition();
  if (typeof document !== 'undefined') {
    document.body.classList.remove(...TRANSIENT_BODY_CLASSES);
  }
}

/**
 * The tenant session is gone (an API call answered 401, or the WebSocket was
 * closed for an invalid session): reset every store and show the login
 * screen. Idempotent — parallel failing requests reset only once.
 */
export function expireSession(): void {
  if (!useAppStore.getState().isAuthenticated) return;
  console.warn('[Auth] Session expired or revoked; returning to the login screen');
  resetAllStores();
  useAppStore.setState({ isAuthChecking: false, isAuthenticated: false });
}
