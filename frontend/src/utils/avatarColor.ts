/**
 * The one avatar palette. Presence avatars (OnlineUsers), activity toasts
 * (ActivityFeed) and Kanban card assignees all colour a person by id through
 * `avatarColorFor`, so the same person has the same colour everywhere.
 *
 * These are data colours (a fixed palette keyed by id), not UI chrome, which
 * is why they are hex literals rather than theme tokens — they must not
 * change between the dark and light themes.
 */

export const AVATAR_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#f97316', // orange
  '#10b981', // green
  '#06b6d4', // cyan
  '#f59e0b', // amber
  '#ef4444', // red
] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

/** Deterministic colour for a user / staff id (negative or huge ids included). */
export function avatarColorFor(id: number): AvatarColor {
  const index = Math.abs(Math.trunc(id)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[Number.isFinite(index) ? index : 0];
}
