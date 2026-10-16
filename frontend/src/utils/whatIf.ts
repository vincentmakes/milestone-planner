/**
 * What-If mode UI helpers.
 *
 * Creating an object during What-If cannot work: the POST is only queued, the
 * server never assigns an id, and the reload that would show the new row is a
 * no-op until Apply. Creation entry points are therefore disabled while the
 * sandbox is active (edits stay allowed), with the same wording the import
 * dialogs use (ICS_IMPORT_WHAT_IF_MESSAGE, ImportProjectModal).
 */

/** e.g. whatIfUnavailableMessage('Adding phases') */
export function whatIfUnavailableMessage(action: string): string {
  return `${action} is unavailable while What-If mode is active. Apply or discard your What-If changes first.`;
}
