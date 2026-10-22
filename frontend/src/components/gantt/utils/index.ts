export {
  generateTimelineCells,
  generateTimelineHeaders,
  generateTimelineData,
  calculateBarPosition,
  calculateTodayPosition,
  calculateTodayCenterScrollLeft,
  findTodayCell,
  findCellIndex,
} from './timeline';

export type { TimelineCell, TimelineHeader } from './timeline';

export {
  extractDependencies,
  calculateDependencyPath,
  getDependencyEdges,
  getDependencyColor,
  DEPENDENCY_STYLES,
  resolveDependencyPredecessor,
  dependencyMatches,
  wouldCreateDependencyCycle,
  findDependencyItem,
} from './dependencies';
export type { DependencyEntity, DependencyItemRef } from './dependencies';

export { calculateRowPositions, SECTION_ROW_TOTAL_HEIGHT } from './rowPositions';
export type { RowPosition, RowPositionsResult } from './rowPositions';

export { cardStaffItems, staffRowCount, staffGroupKey, allocationRange } from './staffGroups';
export type { CardStaffItem, StaffGroupLevel } from './staffGroups';

export {
  cascadeDependentPhases,
  cascadeDependentSubphases,
  cascadeParentDatesUp,
  cascadePhaseDatesFromChildren,
  autoAdjustProjectDates,
  savePendingUpdates,
  processPhaseMove,
  processSubphaseMove,
  moveChildrenByOffset,
  movePhasesWithProject,
  fitCardBookings,
  cloneProject,
} from './autoCalculation';
export type { PendingUpdate } from './autoCalculation';

export {
  calculateCriticalPath,
  isPhaseOnCriticalPath,
  isSubphaseOnCriticalPath,
} from './criticalPath';
export type { CriticalPathResult } from './criticalPath';

export { diffProjects } from './diffProjects';

export { pixelOfDate } from './timelinePixels';
export type { DomTimelineCell } from './timelinePixels';

export {
  buildProjectSections,
  buildGanttRows,
  flatGanttRows,
  allSectionKeys,
  ganttSectionKey,
} from './projectSections';
export type { GanttSection, GanttSectionKey, GanttRow } from './projectSections';
