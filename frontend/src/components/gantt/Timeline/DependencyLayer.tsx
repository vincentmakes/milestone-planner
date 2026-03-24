/**
 * DependencyLayer
 * SVG overlay that renders dependency arrows between phases/subphases
 */

import { memo, useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useViewStore } from '@/stores/viewStore';
import { useCustomColumnStore } from '@/stores/customColumnStore';
import { useUIStore } from '@/stores/uiStore';
import { 
  extractDependencies, 
  calculateDependencyPath, 
  getDependencyEdges,
  DEPENDENCY_STYLES 
} from '../utils/dependencies';
import { calculateBarPosition } from '../utils/timeline';
import { getPhaseColor } from '@/utils/themeColors';
import type { TimelineCell } from '../utils/timeline';
import type { Project, DependencyType, Subphase, Dependency } from '@/types';
import { DependencyPopup } from './DependencyPopup';
import { updatePhase, updateSubphase, loadAllProjects } from '@/api/endpoints/projects';
import styles from './DependencyLayer.module.css';

interface DependencyLayerProps {
  projects: Project[];
  cells: TimelineCell[];
  cellWidth: number;
  rowPositions: Map<string, { top: number; height: number }>;
}

interface SelectedDependency {
  id: string;
  type: DependencyType;
  fromId: number;
  toId: number;
  fromType: 'phase' | 'subphase';
  toType: 'phase' | 'subphase';
  projectId: number;
  fromName: string;
  toName: string;
  x: number;
  y: number;
}

export const DependencyLayer = memo(function DependencyLayer({
  projects,
  cells,
  cellWidth,
  rowPositions,
}: DependencyLayerProps) {
  // Get viewMode and setProjects from stores
  const viewMode = useViewStore((s) => s.viewMode);
  const setProjects = useAppStore((s) => s.setProjects);
  const showAssignments = useViewStore((s) => s.showAssignments);
  const customColumnFilters = useCustomColumnStore((s) => s.customColumnFilters);
  
  // Get drag state to re-measure after drag ends
  const isDragging = useUIStore((s) => s.isDragging);
  
  // Ref to measure actual DOM positions
  const containerRef = useRef<SVGSVGElement>(null);
  const [domPositions, setDomPositions] = useState<Map<string, { top: number; height: number }>>(new Map());
  // Counter to force re-measurement during drag
  const [measureCounter, setMeasureCounter] = useState(0);
  
  // Selected dependency for popup
  const [selectedDep, setSelectedDep] = useState<SelectedDependency | null>(null);
  
  // Force re-measurement during drag with throttling
  useEffect(() => {
    if (!isDragging) return;
    
    // Throttle measurements to ~30fps during drag
    const intervalId = setInterval(() => {
      setMeasureCounter(c => c + 1);
    }, 33);
    
    return () => clearInterval(intervalId);
  }, [isDragging]);
  
  // Measure actual DOM positions after render
  useEffect(() => {
    // Use RAF to ensure DOM has fully rendered
    const rafId = requestAnimationFrame(() => {
      if (!containerRef.current) return;
      
      // Find the rows container (sibling of this SVG)
      const rowsContainer = containerRef.current.parentElement?.querySelector('[class*="rows"]');
      if (!rowsContainer) return;
      
      const newPositions = new Map<string, { top: number; height: number }>();
      
      // Find all phase and subphase rows by data attribute
      const phaseRows = rowsContainer.querySelectorAll('[data-phase-id]');
      phaseRows.forEach((row) => {
        const phaseId = row.getAttribute('data-phase-id');
        if (phaseId) {
          const rect = row.getBoundingClientRect();
          const containerRect = rowsContainer.getBoundingClientRect();
          newPositions.set(`phase-${phaseId}`, {
            top: rect.top - containerRect.top,
            height: rect.height,
          });
        }
      });
      
      const subphaseRows = rowsContainer.querySelectorAll('[data-subphase-id]');
      subphaseRows.forEach((row) => {
        const subphaseId = row.getAttribute('data-subphase-id');
        if (subphaseId) {
          const rect = row.getBoundingClientRect();
          const containerRect = rowsContainer.getBoundingClientRect();
          newPositions.set(`subphase-${subphaseId}`, {
            top: rect.top - containerRect.top,
            height: rect.height,
          });
        }
      });
      
      setDomPositions(newPositions);
    });
    
    return () => cancelAnimationFrame(rafId);
  }, [projects, rowPositions, showAssignments, customColumnFilters, isDragging, measureCounter]); // Re-measure when drag ends or measureCounter changes
  
  // Use DOM positions if available, fall back to calculated
  const effectivePositions = domPositions.size > 0 ? domPositions : rowPositions;
  
  // Extract all dependencies from projects
  const dependencies = useMemo(
    () => extractDependencies(projects),
    [projects]
  );

  // Calculate visible dependencies (only show if both source and target are visible)
  const visibleDependencies = useMemo(() => {
    return dependencies.filter((dep) => {
      // Check if source is visible
      const sourceKey = `${dep.fromType}-${dep.fromId}`;
      const targetKey = `${dep.toType}-${dep.toId}`;
      
      // Both must have positions (meaning they're rendered)
      return rowPositions.has(sourceKey) && rowPositions.has(targetKey);
    });
  }, [dependencies, rowPositions]);

  // Build a map of phase/subphase to their dates and color for position calculation
  const itemDatesMap = useMemo(() => {
    const map = new Map<string, { start_date: string; end_date: string; color: string }>();
    
    projects.forEach((project) => {
      // Add phases
      (project.phases ?? []).forEach((phase) => {
        map.set(`phase-${phase.id}`, { 
          start_date: phase.start_date, 
          end_date: phase.end_date,
          color: phase.color
        });
        
        // Add subphases recursively
        const addSubphases = (subphases: typeof phase.children, parentColor: string) => {
          (subphases ?? []).forEach((sp) => {
            map.set(`subphase-${sp.id}`, { 
              start_date: sp.start_date, 
              end_date: sp.end_date,
              color: sp.color || parentColor
            });
            if (sp.children?.length) {
              addSubphases(sp.children, sp.color || parentColor);
            }
          });
        };
        addSubphases(phase.children, phase.color);
      });
    });
    
    return map;
  }, [projects]);

  // Calculate arrow paths
  const arrowPaths = useMemo(() => {
    return visibleDependencies.map((dep) => {
      const sourceKey = `${dep.fromType}-${dep.fromId}`;
      const targetKey = `${dep.toType}-${dep.toId}`;
      
      // Use DOM-measured positions if available
      const sourcePos = effectivePositions.get(sourceKey);
      const targetPos = effectivePositions.get(targetKey);
      const sourceDates = itemDatesMap.get(sourceKey);
      const targetDates = itemDatesMap.get(targetKey);
      
      if (!sourcePos || !targetPos || !sourceDates || !targetDates) {
        return null;
      }

      // Calculate bar positions
      const sourceBar = calculateBarPosition(
        sourceDates.start_date,
        sourceDates.end_date,
        cells,
        cellWidth,
        viewMode
      );
      const targetBar = calculateBarPosition(
        targetDates.start_date,
        targetDates.end_date,
        cells,
        cellWidth,
        viewMode
      );

      if (!sourceBar || !targetBar) {
        return null;
      }

      // Get which edges to use based on dependency type
      const { sourceEdge, targetEdge } = getDependencyEdges(dep.type);

      // Calculate X positions
      const fromX = sourceEdge === 'start' ? sourceBar.left : sourceBar.left + sourceBar.width;
      const toX = targetEdge === 'start' ? targetBar.left : targetBar.left + targetBar.width;

      // Calculate Y positions (center of the row)
      const fromY = sourcePos.top + sourcePos.height / 2;
      const toY = targetPos.top + targetPos.height / 2;

      // Calculate the path
      const path = calculateDependencyPath(fromX, fromY, toX, toY, dep.type);

      return {
        ...dep,
        path,
        fromX,
        fromY,
        toX,
        toY,
        sourceColor: sourceDates.color,
      };
    }).filter((x): x is NonNullable<typeof x> & { sourceColor: string } => x !== null);
  }, [visibleDependencies, effectivePositions, itemDatesMap, cells, cellWidth, viewMode]);

  // Build a map of item names for the popup
  const itemNamesMap = useMemo(() => {
    const map = new Map<string, string>();
    
    projects.forEach((project) => {
      (project.phases ?? []).forEach((phase) => {
        map.set(`phase-${phase.id}`, phase.name);
        
        const addSubphaseNames = (subphases: typeof phase.children) => {
          (subphases ?? []).forEach((sp) => {
            map.set(`subphase-${sp.id}`, sp.name);
            if (sp.children?.length) {
              addSubphaseNames(sp.children);
            }
          });
        };
        addSubphaseNames(phase.children);
      });
    });
    
    return map;
  }, [projects]);

  // Handle arrow click
  const handleArrowClick = useCallback((
    e: React.MouseEvent,
    arrow: typeof arrowPaths[0]
  ) => {
    if (!arrow) return;
    
    const fromName = itemNamesMap.get(`${arrow.fromType}-${arrow.fromId}`) || 'Unknown';
    const toName = itemNamesMap.get(`${arrow.toType}-${arrow.toId}`) || 'Unknown';
    
    setSelectedDep({
      id: arrow.id,
      type: arrow.type,
      fromId: arrow.fromId,
      toId: arrow.toId,
      fromType: arrow.fromType,
      toType: arrow.toType,
      projectId: arrow.projectId,
      fromName,
      toName,
      x: e.clientX,
      y: e.clientY,
    });
  }, [itemNamesMap]);

  // Close popup
  const handleClosePopup = useCallback(() => {
    setSelectedDep(null);
  }, []);

  // Delete dependency
  const handleDeleteDependency = useCallback(async () => {
    if (!selectedDep) return;
    
    try {
      // Find the target item and remove the dependency
      const updatedProjects = projects.map(project => {
        if (project.id !== selectedDep.projectId) return project;

        if (selectedDep.toType === 'phase') {
          return {
            ...project,
            phases: (project.phases ?? []).map(phase => {
              if (phase.id !== selectedDep.toId) return phase;
              
              const newDeps = (phase.dependencies ?? []).filter(
                d => !(d.id === selectedDep.fromId && d.type === selectedDep.type)
              );
              return { ...phase, dependencies: newDeps };
            })
          };
        } else {
          // Update subphase recursively
          const updateSubphaseInTree = (subphases: Subphase[]): Subphase[] => {
            return subphases.map(sp => {
              if (sp.id === selectedDep.toId) {
                const newDeps = (sp.dependencies ?? []).filter(
                  (d: Dependency) => !(d.id === selectedDep.fromId && d.type === selectedDep.type)
                );
                return { ...sp, dependencies: newDeps };
              }
              if (sp.children?.length) {
                return { ...sp, children: updateSubphaseInTree(sp.children) };
              }
              return sp;
            });
          };

          return {
            ...project,
            phases: (project.phases ?? []).map(phase => ({
              ...phase,
              children: updateSubphaseInTree(phase.children ?? [])
            }))
          };
        }
      });

      // Optimistic update
      setProjects(updatedProjects);
      setSelectedDep(null);

      // Find the target item to get its current data for the API call
      const targetProject = projects.find(p => p.id === selectedDep.projectId);
      if (!targetProject) return;

      if (selectedDep.toType === 'phase') {
        const targetPhase = (targetProject.phases ?? []).find(p => p.id === selectedDep.toId);
        if (targetPhase) {
          const newDeps = (targetPhase.dependencies ?? []).filter(
            d => !(d.id === selectedDep.fromId && d.type === selectedDep.type)
          );
          await updatePhase(selectedDep.toId, {
            start_date: targetPhase.start_date,
            end_date: targetPhase.end_date,
            dependencies: newDeps,
          });
        }
      } else {
        // Find subphase
        const findSubphase = (subphases: Subphase[]): Subphase | null => {
          for (const sp of subphases) {
            if (sp.id === selectedDep.toId) return sp;
            if (sp.children?.length) {
              const found = findSubphase(sp.children);
              if (found) return found;
            }
          }
          return null;
        };

        let targetSubphase: Subphase | null = null;
        for (const phase of targetProject.phases ?? []) {
          targetSubphase = findSubphase(phase.children ?? []);
          if (targetSubphase) break;
        }

        if (targetSubphase) {
          const newDeps = (targetSubphase.dependencies ?? []).filter(
            (d: Dependency) => !(d.id === selectedDep.fromId && d.type === selectedDep.type)
          );
          await updateSubphase(selectedDep.toId, {
            start_date: targetSubphase.start_date,
            end_date: targetSubphase.end_date,
            dependencies: newDeps,
          });
        }
      }
    } catch (err) {
      console.error('Failed to delete dependency:', err);
      // Reload on error
      const reloadedProjects = await loadAllProjects();
      setProjects(reloadedProjects);
    }
  }, [selectedDep, projects, setProjects]);

  // Always render the SVG to allow DOM measurement, but hide if no arrows
  return (
    <>
      <svg ref={containerRef} className={styles.layer} style={arrowPaths.length === 0 ? { display: 'none' } : undefined}>
        {/* Render dependency arrows */}
        {arrowPaths.map((arrow) => {
          if (!arrow) return null;
          
          const style = DEPENDENCY_STYLES[arrow.type];
          const color = arrow.sourceColor || getPhaseColor();
          // Create unique marker ID for this color
          const markerId = `arrow-${arrow.id}`;

          return (
            <g key={arrow.id} className={styles.dependency}>
              {/* Dynamic marker for this arrow */}
              <defs>
                <marker
                  id={markerId}
                  markerWidth="6"
                  markerHeight="5"
                  refX="5"
                  refY="2.5"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <polygon points="0 0, 6 2.5, 0 5" fill={color} />
                </marker>
              </defs>
              <path
                d={arrow.path}
                stroke={color}
                strokeWidth="1.5"
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={style.dashArray}
                markerEnd={`url(#${markerId})`}
                className={styles.arrow}
              />
              {/* Invisible wider path for easier clicking */}
              <path
                d={arrow.path}
                stroke="transparent"
                strokeWidth="10"
                fill="none"
                className={styles.hitArea}
                data-dependency-id={arrow.id}
                onClick={(e) => handleArrowClick(e, arrow)}
              />
            </g>
          );
        })}
      </svg>
      
      {/* Dependency popup */}
      <DependencyPopup
        visible={selectedDep !== null}
        x={selectedDep?.x ?? 0}
        y={selectedDep?.y ?? 0}
        dependencyType={selectedDep?.type ?? 'FS'}
        fromName={selectedDep?.fromName ?? ''}
        toName={selectedDep?.toName ?? ''}
        onClose={handleClosePopup}
        onDelete={handleDeleteDependency}
      />
    </>
  );
});
