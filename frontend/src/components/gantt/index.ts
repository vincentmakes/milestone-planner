export { GanttContainer } from './GanttContainer';
export { ProjectPanel } from './ProjectPanel';
export { Timeline } from './Timeline';
export { CompletionSlider } from './CompletionSlider';

// Re-export utilities
export {
  generateTimelineCells,
  generateTimelineHeaders,
  generateTimelineData,
  calculateBarPosition,
  calculateTodayPosition,
  findCellIndex,
  extractDependencies,
  calculateDependencyPath,
  getDependencyEdges,
  getDependencyColor,
  DEPENDENCY_STYLES,
  calculateRowPositions,
} from './utils';

export type { TimelineCell, TimelineHeader, RowPosition, RowPositionsResult } from './utils';

// Re-export hooks
export { useScrollSync } from './hooks';
