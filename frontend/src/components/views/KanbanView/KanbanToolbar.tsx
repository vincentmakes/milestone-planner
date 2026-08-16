/**
 * Kanban toolbar: project picker, swimlane grouping, My Todo filter.
 */

import { Select } from '@/components/common';
import type { CustomColumn, Project } from '@/types';
import type { KanbanGrouping } from '@/utils/kanbanCards';
import styles from './KanbanToolbar.module.css';

interface KanbanToolbarProps {
  projects: Project[];
  selectedProjectId: number | null;
  onSelectProject: (projectId: number) => void;
  grouping: KanbanGrouping;
  groupingColumnId: number | null;
  listColumns: CustomColumn[];
  onChangeGrouping: (grouping: KanbanGrouping, columnId: number | null) => void;
  myTodoOnly: boolean;
  onToggleMyTodo: () => void;
  cardCount: number;
  totalCount: number;
}

/**
 * Grouping is encoded as a single select value: the fixed modes use their own
 * key, and a custom column uses `column:<id>` so one control drives both the
 * mode and which column it groups by.
 */
const CUSTOM_PREFIX = 'column:';

export function KanbanToolbar({
  projects,
  selectedProjectId,
  onSelectProject,
  grouping,
  groupingColumnId,
  listColumns,
  onChangeGrouping,
  myTodoOnly,
  onToggleMyTodo,
  cardCount,
  totalCount,
}: KanbanToolbarProps) {
  const groupingValue =
    grouping === 'customColumn' && groupingColumnId !== null
      ? `${CUSTOM_PREFIX}${groupingColumnId}`
      : grouping;

  const groupingOptions = [
    { value: 'none', label: 'No grouping' },
    { value: 'phase', label: 'Group by phase' },
    { value: 'assignee', label: 'Group by assignee' },
    ...listColumns.map((c) => ({
      value: `${CUSTOM_PREFIX}${c.id}`,
      label: `Group by ${c.name}`,
    })),
  ];

  const handleGroupingChange = (raw: string) => {
    if (raw.startsWith(CUSTOM_PREFIX)) {
      onChangeGrouping('customColumn', Number(raw.slice(CUSTOM_PREFIX.length)));
    } else {
      onChangeGrouping(raw as KanbanGrouping, null);
    }
  };

  return (
    <div className={styles.toolbar}>
      <Select
        aria-label="Project"
        className={styles.projectSelect}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        value={selectedProjectId ?? ''}
        placeholder={projects.length === 0 ? 'No projects' : undefined}
        disabled={projects.length === 0}
        onChange={(e) => onSelectProject(Number(e.target.value))}
      />

      <Select
        aria-label="Swimlane grouping"
        options={groupingOptions}
        value={groupingValue}
        onChange={(e) => handleGroupingChange(e.target.value)}
      />

      <button
        type="button"
        className={`${styles.todoToggle} ${myTodoOnly ? styles.active : ''}`}
        onClick={onToggleMyTodo}
        aria-pressed={myTodoOnly}
        title="Show only cards assigned to me"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        My Todo
      </button>

      <span className={styles.count}>
        {myTodoOnly && cardCount !== totalCount
          ? `${cardCount} of ${totalCount} cards`
          : `${cardCount} card${cardCount === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}
