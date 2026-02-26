export {
  generateTimelineCells,
  generateTimelineHeaders,
  generateTimelineData,
  calculateBarPosition,
  calculateTodayPosition,
  findCellIndex,
} from './timeline';

export type { TimelineCell, TimelineHeader } from './timeline';

export {
  extractDependencies,
  calculateDependencyPath,
  getDependencyEdges,
  getDependencyColor,
  DEPENDENCY_STYLES,
} from './dependencies';

export { calculateRowPositions } from './rowPositions';
export type { RowPosition, RowPositionsResult } from './rowPositions';

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
  cloneProject,
} from './autoCalculation';
export type { PendingUpdate } from './autoCalculation';

export {
  calculateCriticalPath,
  isPhaseOnCriticalPath,
  isSubphaseOnCriticalPath,
} from './criticalPath';
export type { CriticalPathResult } from './criticalPath';
