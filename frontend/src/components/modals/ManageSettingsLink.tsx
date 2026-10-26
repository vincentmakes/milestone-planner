/**
 * ManageSettingsLink - the "Manage tags…" / "Manage fields…" shortcut of the
 * project dialog to a Settings hub section.
 *
 * Shown only to holders of `permission`. It asks first (the dialog closes and
 * its unsaved input is lost), then closes the dialog — so its editing context
 * is cleared — and opens the hub on `section`.
 * - `disabled` (the dialog is saving) locks it: opening the hub mid-save would
 *   be closed again by the save's own closeModal().
 * - Disabled with the reason during What-If: the hub cannot open then
 *   (uiStore), and closing the dialog first would lose its input.
 */

import { useAppStore } from '@/stores/appStore';
import { useUIStore } from '@/stores/uiStore';
import type { SettingsSectionId } from '@/stores/uiStore';
import { useWhatIfBlocked } from '@/hooks/useWhatIfBlocked';
import { confirmAction } from '@/utils/confirmDialog';
import { can } from '@/utils/permissions';
import type { PermissionKey } from '@/types/permissions';
import styles from './ManageSettingsLink.module.css';

interface ManageSettingsLinkProps {
  section: SettingsSectionId;
  /** Link text, e.g. "Manage tags…" */
  label: string;
  /** Title of the confirmation, e.g. "Manage tags" */
  confirmTitle: string;
  confirmMessage: string;
  /** What-If wording, e.g. "Managing tags" */
  blockedAction: string;
  permission: PermissionKey;
  disabled?: boolean;
}

export function ManageSettingsLink({
  section,
  label,
  confirmTitle,
  confirmMessage,
  blockedAction,
  permission,
  disabled = false,
}: ManageSettingsLinkProps) {
  const allowed = useAppStore((s) => can(s.currentUser, permission));
  const whatIf = useWhatIfBlocked();
  const blockedReason = whatIf.blocked ? whatIf.reason(blockedAction) : null;

  if (!allowed) return null;

  const handleClick = async () => {
    if (disabled || blockedReason) return;
    const confirmed = await confirmAction({
      title: confirmTitle,
      message: confirmMessage,
      confirmLabel: 'Open settings',
    });
    if (!confirmed) return;
    const ui = useUIStore.getState();
    ui.closeModal();
    ui.openSettings(section);
  };

  return (
    <button
      type="button"
      className={styles.manageLink}
      onClick={handleClick}
      disabled={disabled || blockedReason !== null}
      title={blockedReason ?? undefined}
    >
      {label}
    </button>
  );
}
