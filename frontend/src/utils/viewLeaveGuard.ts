/**
 * The one "may the user leave this view?" check (2.1.0).
 *
 * A view holding unsaved work (the dashboard builder's draft) registers a
 * guard that asks the user — through `confirmAction()` — before the view is
 * switched away; the sidebar navigation and the notification bell's links
 * consult it before `setCurrentView`. Without a guard the switch stays
 * synchronous, so nothing changes for the other views.
 *
 *   useEffect(() => (editing ? setViewLeaveGuard(confirmDiscard) : undefined), [editing, confirmDiscard]);
 *   leaveViewThen(() => setCurrentView('gantt'));
 *
 * The forced fallback of MainLayout (a view whose permission was taken away)
 * does not ask.
 */

export type ViewLeaveGuard = () => Promise<boolean>;

let guard: ViewLeaveGuard | null = null;

/** Register the guard of the current view; returns the unregister function. */
export function setViewLeaveGuard(next: ViewLeaveGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

/** The registered guard, if any. */
export function viewLeaveGuard(): ViewLeaveGuard | null {
  return guard;
}

/** Run `go` now when nothing guards the view, else once the guard agrees. */
export function leaveViewThen(go: () => void): void {
  const current = guard;
  if (!current) {
    go();
    return;
  }
  void current().then((ok) => {
    if (ok) go();
  });
}
