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
  calculateTodayCenterScrollLeft,
  findTodayCell,
  findCellIndex,
  extractDependencies,
  calculateDependencyPath,
  getDependencyEdges,
  getDependencyColor,
  DEPENDENCY_STYLES,
  calculateRowPositions,
  SECTION_ROW_TOTAL_HEIGHT,
  buildProjectSections,
  buildGanttRows,
  flatGanttRows,
  allSectionKeys,
  ganttSectionKey,
} from './utils';

export type {
  TimelineCell,
  TimelineHeader,
  RowPosition,
  RowPositionsResult,
  GanttSection,
  GanttSectionKey,
  GanttRow,
} from './utils';
