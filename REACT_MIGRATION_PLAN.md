# React Migration Plan - Complete Feature Analysis

## Current Status Overview

The React migration is approximately **60% complete**. Core infrastructure, layout, basic Gantt rendering, drag/drop, resize, and alternative views are functional. However, several advanced features from the vanilla JS implementation are missing.

---

## Feature Gap Analysis

### ✅ COMPLETED FEATURES

#### Phase 1: Foundation & Infrastructure
- [x] React + TypeScript setup with Vite
- [x] Zustand stores (appStore, uiStore)
- [x] API client with axios
- [x] Authentication flow (login, SSO redirect)
- [x] Docker deployment configuration
- [x] Environment configuration

#### Phase 2: Core Layout Components
- [x] Header with logo, site selector, view mode controls
- [x] Sidebar navigation
- [x] Resource panel (right sidebar)
- [x] Main layout structure
- [x] Theme toggle (dark/light)
- [x] What If mode toggle

#### Phase 3: Gantt Chart Foundation
- [x] Timeline header (primary/secondary rows)
- [x] Timeline grid with CSS gradient
- [x] Project panel with expandable rows
- [x] Phase/Subphase hierarchy display
- [x] Staff/Equipment assignment rows
- [x] WBS numbering
- [x] Level collapse controls
- [x] Weekend highlighting
- [x] Bank holiday highlighting
- [x] Today marker
- [x] Scroll synchronization
- [x] View modes (Week, Month, Quarter, Year)
- [x] Date navigation with Today button

#### Phase 4: Interactions & Modals
- [x] Phase drag to move
- [x] Subphase drag to move
- [x] Phase resize (left/right handles)
- [x] Subphase resize
- [x] Click to edit (opens modal)
- [x] Project modal (create/edit)
- [x] Phase modal (create/edit)
- [x] Subphase modal (create/edit)
- [x] Staff assignment modal
- [x] Equipment assignment modal
- [x] Milestone rendering (diamond shape)

#### Phase 5: Alternative Views
- [x] Staff View with stacked bars
- [x] Equipment View
- [x] Cross-Site View with privacy masking
- [x] Archived View (Gantt-style)

#### Partially Implemented Features
- [~] View State Persistence (localStorage structure exists but not all state persisted)
- [~] What-If Mode (toggle exists but snapshot/apply/discard not fully wired)

---

### ❌ MISSING FEATURES (Prioritized)

#### Priority 1: Dependencies (Critical for Project Planning)

**1.1 Dependency Arrows/Lines**
- SVG overlay for rendering dependency arrows between phases/subphases
- Different dependency types: FS (Finish-to-Start), SS (Start-to-Start), FF (Finish-to-Finish), SF (Start-to-Finish)
- Visual styles per type (solid, dashed, different dash patterns)
- Arrow routing to avoid overlaps (horizontal/vertical path segments)
- Arrow colors based on dependency validity (on-time vs violated)

**1.2 Dependency Creation**
- Drag from phase end zone to create FS dependency
- Drag from phase start zone to create SS dependency
- Click-based dependency linking mode
- Visual feedback during linking (highlight valid targets)

**1.3 Dependency Editing**
- Click on arrow to select
- Edit lag/lead time
- Change dependency type
- Delete dependency

**1.4 Lag/Lead Indicators**
- Display lag (+days) or lead (-days) on dependency lines
- Color coding for early/late dependencies

#### Priority 2: Progress Tracking

**2.1 Completion Bars**
- Inner progress bar showing % completion
- Gradient fill showing completed portion
- Display percentage text on bar or tooltip

**2.2 Project-Level Completion**
- Aggregate completion from phases (weighted by duration)
- Visual indicator on project bar

#### Priority 3: Auto-Calculation Logic (Critical for Data Integrity)

**3.1 Parent Date Auto-Adjustment from Children**
When a child (subphase) is moved or resized, parent dates must cascade upward:

```typescript
// Vanilla JS Implementation Reference (gantt.js)
function autoAdjustParentDatesFromChild(project, childId, childType) {
  // Find the parent of the moved/resized child
  let parentInfo = findParent(project.phases, childId);
  
  while (parentInfo) {
    const parent = parentInfo.item;
    const children = parentInfo.type === 'phase' 
      ? parent.children 
      : parent.children;
    
    if (!children || children.length === 0) break;
    
    // Find earliest start and latest end among all children
    let earliestStart = null;
    let latestEnd = null;
    
    children.forEach(child => {
      const start = new Date(child.start_date);
      const end = new Date(child.end_date);
      if (!earliestStart || start < earliestStart) earliestStart = start;
      if (!latestEnd || end > latestEnd) latestEnd = end;
    });
    
    // Update parent dates if they changed
    let needsUpdate = false;
    if (earliestStart.getTime() !== new Date(parent.start_date).getTime()) {
      parent.start_date = formatDateLocal(earliestStart);
      needsUpdate = true;
    }
    if (latestEnd.getTime() !== new Date(parent.end_date).getTime()) {
      parent.end_date = formatDateLocal(latestEnd);
      needsUpdate = true;
    }
    
    // Persist to server if changed
    if (needsUpdate) {
      // API call to update phase/subphase
    }
    
    // Continue cascading up to project level
    if (parentInfo.type === 'phase') {
      autoAdjustProjectDates(project);
      break;
    } else {
      currentId = parent.id;
      parentInfo = findParent(project.phases, currentId);
    }
  }
}
```

**3.2 Project Date Auto-Adjustment from Phases**

```typescript
function autoAdjustProjectDates(project) {
  if (!project.phases || project.phases.length === 0) return;
  
  let earliestStart = null;
  let latestEnd = null;
  
  project.phases.forEach(phase => {
    const start = new Date(phase.start_date);
    const end = new Date(phase.end_date);
    if (!earliestStart || start < earliestStart) earliestStart = start;
    if (!latestEnd || end > latestEnd) latestEnd = end;
  });
  
  // Update project dates
  project.start_date = formatDateLocal(earliestStart);
  project.end_date = formatDateLocal(latestEnd);
  
  // Persist to server
}
```

**3.3 Dependency-Driven Date Propagation**
When a predecessor changes, successors should optionally auto-adjust:
- FS: Successor start = Predecessor end + lag
- SS: Successor start = Predecessor start + lag
- FF: Successor end = Predecessor end + lag
- SF: Successor start = Predecessor start + lag

**3.4 Move Phase with Children**
When dragging a phase, all subphases must move together:
- Calculate offset (newStart - oldStart)
- Apply same offset to all descendant subphases
- Cascade parent date updates after move

**3.5 Subphase Color Inheritance**
- New subphases inherit parent color by default
- Color can be overridden per subphase
- Visual consistency maintained in hierarchy

#### Priority 4: Staff Vacation Management

**4.1 Vacation CRUD Modal**
- Create vacation with: staff_id, start_date, end_date, description
- Edit existing vacation
- Delete vacation with confirmation
- Visual display in Staff View and Resource Panel

**4.2 Vacation Display**
- Purple bars in Staff View timeline
- "OFF" indicator in workload cells
- Conflict detection (vacation + assignment overlap)

**4.3 Vacation Export**
- Generate ICS file for calendar import
- ICS format with Out of Office status:
```
X-MICROSOFT-CDO-BUSYSTATUS:OOF
X-MICROSOFT-CDO-ALLDAYEVENT:TRUE
```
- SSO users: Open Outlook Web with pre-filled event
- Non-SSO users: Download .ics file

#### Priority 5: Bank Holiday Management

**5.1 Bank Holiday Display**
- Fetch from Nager.Date API per site country/region
- Cache in database with 6-month refresh
- Display as highlighted columns in timeline

**5.2 Custom Holiday CRUD**
- Add custom holidays per site
- Support date ranges (start_date, end_date)
- Edit/delete custom holidays
- Site-specific (not shared across sites)

**5.3 Bank Holiday Export**
- Export all holidays for a year to ICS
- Bulk export for calendar import

**5.4 Site Holiday Configuration**
- Configure country_code per site (CH, DE, FR, IT)
- Configure region_code for regional holidays (ZH, BY, etc.)
- Auto-fetch on site creation/edit

#### Priority 6: Staff Workload Heatmap (Staff View)

**6.1 Per-Cell Workload Calculation**
For each day/week cell in Staff View timeline:

```typescript
interface WorkloadCell {
  total: number;           // Total allocation percentage
  assignments: Assignment[]; // Contributing assignments
  isOnVacation: boolean;
  available: number;       // 100 - total (or 0 if vacation)
}

function calculateWorkloadPerCell(staff, cells, assignments, vacations) {
  return cells.map(cell => {
    const cellDate = cell.date;
    
    // Check if on vacation
    const isOnVacation = vacations.some(v => 
      cellDate >= v.start_date && cellDate <= v.end_date
    );
    
    // Sum allocations for this cell
    const activeAssignments = assignments.filter(a =>
      cellDate >= a.start_date && cellDate <= a.end_date
    );
    
    const total = activeAssignments.reduce((sum, a) => sum + a.allocation, 0);
    
    return {
      total,
      assignments: activeAssignments,
      isOnVacation,
      available: isOnVacation ? 0 : Math.max(0, 100 - total)
    };
  });
}
```

**6.2 Visual Rendering**
- **Vacation**: Purple background (rgba(139, 92, 246, 0.4)), "OFF" indicator
- **Overloaded (>100%)**: Red gradient from bottom, percentage shown
- **Fully allocated (100%)**: Solid blue (rgba(59, 130, 246, 0.3))
- **Partially allocated**: Blue gradient proportional to allocation
- **Conflict (vacation + work)**: Purple with "0%" indicator

**6.3 CSS Implementation**
```css
.workload-cell {
  position: relative;
}

.workload-cell.overloaded {
  background: linear-gradient(
    to top, 
    rgba(239, 68, 68, 0.5) var(--workload-percent), 
    transparent var(--workload-percent)
  );
}

.workload-indicator {
  position: absolute;
  bottom: 2px;
  right: 2px;
  font-size: 9px;
  padding: 1px 3px;
  border-radius: 2px;
}

.workload-indicator.overload { background: #ef4444; color: white; }
.workload-indicator.full { background: #3b82f6; color: white; }
.workload-indicator.vacation { background: #8b5cf6; color: white; }
```

#### Priority 7: Phantom Sibling Mode (Advanced Feature)

**7.1 Phantom Bar Creation**
- Shift+click on phase dependency zone to enter phantom mode
- Ghost bar appears connected to source
- Mouse movement adjusts phantom position/duration

**7.2 Phantom to Real Conversion**
- Click to confirm phantom as new phase/subphase
- Automatic dependency creation
- Proper ordering (insert after sibling)

**7.3 Phantom Visual Feedback**
- Phantom arrow connecting source to ghost
- Lag indicator showing dependency offset
- Color coding by depth level

**7.4 Dependency Type from Click Zone**
- Start zone (left) → SS dependency
- End zone (right) → FS dependency

**7.5 Initial Phantom Position**
- FS: Phantom starts day after sibling ends
- SS: Phantom starts same day as sibling starts
- Default duration = sibling duration

#### Priority 8: Context Menus

**8.1 Project Context Menu**
- Right-click on project row
- Options: Edit, Add Phase, Delete, Archive/Unarchive, Duplicate

**8.2 Phase Context Menu**
- Right-click on phase bar
- Options: Edit, Add Subphase, Add Dependency, Delete, Convert to Milestone

**8.3 Subphase Context Menu**
- Right-click on subphase bar
- Options: Edit, Add Child Subphase, Add Dependency, Delete, Convert to Milestone

#### Priority 9: Advanced Interactions

**9.1 Ctrl+Scroll Zoom**
- Hold Ctrl and scroll to zoom in/out
- Adjusts cell width dynamically
- Maintains scroll position around cursor

**9.2 Keyboard Shortcuts**
- Delete: Remove selected item
- Ctrl+Z: Undo
- Ctrl+Y: Redo
- Escape: Cancel current operation
- Arrow keys: Navigate selection

**9.3 Undo/Redo System**
- Action history stack
- Undo/redo buttons in toolbar
- Support for all CRUD operations

**9.4 What-If Mode (Complete Implementation)**
- Create snapshot on enter What-If mode
- Intercept API write operations (return fake success)
- "Apply Changes" compares snapshot vs current and saves differences
- "Discard" reloads page to restore original state
- Visual indicator: glowing blue border (3px animated)

**9.5 View State Persistence (Complete Implementation)**
- Save to localStorage with 7-day expiration
- Persist: expanded projects, expanded phases, expanded subphases
- Persist: view mode (Week/Month/Quarter/Year)
- Persist: scroll position (scrollLeft, scrollTop)
- Persist: current date position
- Auto-save on scroll, expand/collapse, view changes
- Check savedAt timestamp; clear if >7 days old

#### Priority 10: UI Polish

**10.1 Tooltips**
- Hover tooltips on bars showing details
- Phase: name, dates, duration, completion
- Assignment: staff/equipment, allocation, dates

**10.2 Selection State**
- Click to select phase/subphase
- Visual highlight for selected items
- Multi-select with Ctrl+click

**10.3 Validation Visual Feedback**
- Red highlight for overallocated resources
- Warning indicators for schedule conflicts
- Dependency violation highlighting

#### Priority 11: Additional Modals

**11.1 Site Management Modal**
- Add/edit/delete sites
- Configure country_code, region_code for holidays
- Configure site settings

**11.2 User Management Modal**
- Add/edit/delete users
- Role assignment (Admin, Superuser, User, Viewer)
- Site assignment (checkboxes for multiple sites)
- Toggle active/inactive

**11.3 SSO Configuration Modal**
- Configure Microsoft Entra settings (Tenant ID, Client ID, Client Secret, Redirect URI)
- Enable/disable toggle
- Auto-create users option
- Test SSO connection

**11.4 Bank Holiday Management Modal**
- View holidays for site/year
- Add custom holiday (single date or range)
- Delete custom holidays
- Refresh from API button
- Export to ICS

**11.5 Vacation Modal**
- Staff selector
- Date range picker
- Description field
- Export to Outlook/ICS button
- Save & Export combined action

**11.6 Predefined Phases Modal**
- Configure default phase templates
- Set default colors per phase type
- Reorder phases
- Add/edit/delete templates

**11.7 Import Project Modal**
- Import from MS Project (.mpp) via MPXJ
- Import from CSV
- Preview imported data before confirm
- Preserve hierarchy and dependencies

**11.8 Equipment Management Modal**
- Add/edit/delete equipment records
- Equipment type and site assignment
- Toggle active/inactive

#### Priority 12: Row Reordering & Export

**12.1 Phase Reorder**
- Drag phases to change order within project
- Drop indicator shows target position
- Persist sort_order to database

**12.2 Subphase Reorder**
- Drag subphases to change order within parent
- Preserve hierarchy during reorder

**12.3 CSV Export**
- Export projects to CSV format compatible with MS Project
- Include columns: ID, Name, Duration, Start, Finish, Predecessors, Outline Level
- Preserve all dependency types (FS, SS, FF, SF) with format: `2FS+5d`, `3SS`
- Milestones indicated with ◆ symbol

**12.4 ICS Export**
- Export vacations to ICS format
- Export bank holidays to ICS format
- Out of Office status for Outlook compatibility

---

## Updated Migration Phases

### Phase 6: Dependencies & Progress (Est: 1.5 weeks)

**Week 1: Dependency Rendering**
- [ ] Create SVG overlay component for dependencies
- [ ] Implement arrow path calculation with routing
- [ ] Support all dependency types (FS, SS, FF, SF)
- [ ] Add different line styles per type
- [ ] Implement arrow color based on status

**Week 1.5: Dependency Interactions**
- [ ] Add dependency zones to phase bars
- [ ] Implement drag-to-link functionality
- [ ] Create dependency editing UI
- [ ] Add lag/lead editing
- [ ] Implement dependency deletion

**Parallel: Progress Bars**
- [ ] Add completion bar rendering to PhaseBar
- [ ] Implement project-level completion calculation
- [ ] Add completion percentage display

### Phase 7: Auto-Calculation & Data Integrity (Est: 1 week)

**Parent-Child Cascading**
- [ ] Implement autoAdjustParentDatesFromChild
- [ ] Implement autoAdjustProjectDates
- [ ] Wire cascading to drag/resize operations
- [ ] Wire cascading to modal save operations
- [ ] Add optimistic UI updates with rollback

**Dependency Propagation (Optional)**
- [ ] Implement dependency-driven successor adjustment
- [ ] Add user preference for auto-propagation
- [ ] Handle circular dependency detection

### Phase 8: Vacation & Bank Holidays (Est: 1 week)

**Vacation Management**
- [ ] Create VacationModal component
- [ ] Implement vacation CRUD API integration
- [ ] Add vacation bars to Staff View
- [ ] Implement vacation conflict detection
- [ ] Add ICS export functionality
- [ ] Add Outlook Web integration for SSO users

**Bank Holiday Management**
- [ ] Create BankHolidayModal component
- [ ] Implement custom holiday CRUD
- [ ] Add holiday range support (multi-day)
- [ ] Wire site country/region to holiday fetch
- [ ] Add ICS export for holidays
- [ ] Add refresh from API button

### Phase 9: Staff Workload Heatmap (Est: 0.5 weeks)

**Workload Calculation**
- [ ] Create useWorkloadCalculation hook
- [ ] Calculate per-cell workload percentages
- [ ] Handle vacation overlay logic

**Visual Rendering**
- [ ] Implement gradient backgrounds
- [ ] Add workload indicators (percentage badges)
- [ ] Style overload/full/partial states
- [ ] Add conflict highlighting (vacation + work)
- [ ] Add tooltips with breakdown

### Phase 10: Phantom Sibling & Context Menus (Est: 1 week)

**Phantom Mode**
- [ ] Implement phantom sibling state in uiStore
- [ ] Create phantom bar rendering
- [ ] Add phantom arrow visualization
- [ ] Implement lag indicator during drag
- [ ] Convert phantom to real on confirm
- [ ] Handle automatic dependency creation
- [ ] Determine dependency type from click zone

**Context Menus**
- [ ] Create ContextMenu component
- [ ] Implement project context menu
- [ ] Implement phase context menu
- [ ] Implement subphase context menu
- [ ] Wire up all menu actions

### Phase 11: Advanced Interactions (Est: 1.5 weeks)

**Keyboard & Mouse**
- [ ] Implement Ctrl+Scroll zoom
- [ ] Add keyboard shortcut system
- [ ] Implement selection state
- [ ] Add multi-select support

**Undo/Redo**
- [ ] Create action history store
- [ ] Implement undo/redo for all operations
- [ ] Add toolbar buttons

**What-If Mode**
- [ ] Create snapshot mechanism on mode enter
- [ ] Intercept API write operations in What-If mode
- [ ] Implement Apply Changes (diff and save)
- [ ] Implement Discard (reload page)
- [ ] Add glowing border visual indicator

**View State Persistence**
- [ ] Implement localStorage save/restore
- [ ] Persist expanded states (projects, phases, subphases)
- [ ] Persist view mode and scroll position
- [ ] Persist current date position
- [ ] Add 7-day expiration check
- [ ] Auto-save on state changes (debounced)

### Phase 12: Reordering & Export (Est: 0.5 weeks)

**Row Reordering**
- [ ] Implement phase drag-to-reorder
- [ ] Implement subphase drag-to-reorder
- [ ] Add drop indicator visual feedback
- [ ] Persist sort_order to database

**Export Functionality**
- [ ] Implement CSV export (MS Project compatible)
- [ ] Format predecessors column correctly (2FS+5d format)
- [ ] Include outline levels for hierarchy
- [ ] Add milestone indicator (◆ symbol)

### Phase 13: Remaining Modals (Est: 1 week)

**Admin Modals**
- [ ] Site Management Modal (with holiday config)
- [ ] User Management Modal (with role/site assignment)
- [ ] SSO Configuration Modal (Entra settings)
- [ ] Equipment Management Modal

**Configuration Modals**
- [ ] Predefined Phases Modal (templates)
- [ ] Import Project Modal (MPP + CSV)

### Phase 14: Testing & Polish (Est: 1 week)

**Testing**
- [ ] Unit tests for stores
- [ ] Unit tests for utilities
- [ ] Unit tests for auto-calculation logic
- [ ] Integration tests for API
- [ ] E2E tests for critical flows

**Polish**
- [ ] Performance optimization
- [ ] Accessibility audit (a11y)
- [ ] Cross-browser testing
- [ ] Mobile responsiveness check
- [ ] Documentation

### Phase 15: Migration & Deployment (Est: 0.5 weeks)

- [ ] Production build optimization
- [ ] Docker integration finalization
- [ ] CI/CD pipeline setup
- [ ] User migration guide
- [ ] Feature parity verification

---

## Dependency System Deep Dive

### Data Structures

```typescript
// Existing in types/models.ts
interface Dependency {
  id: number;
  type: DependencyType;
  // Need to add:
  from_phase_id?: number;
  from_subphase_id?: number;
  to_phase_id?: number;
  to_subphase_id?: number;
  lag_days: number; // positive = lag, negative = lead
}

type DependencyType = 'FS' | 'FF' | 'SS' | 'SF';
```

### SVG Overlay Architecture

```
GanttContainer
└── Timeline
    └── TimelineBody
        ├── [Grid layers]
        ├── [Project rows with bars]
        └── DependencyLayer (SVG overlay, position: absolute)
            ├── <defs> (arrow markers)
            └── <path> for each dependency
```

### Arrow Path Calculation

```typescript
function calculateDependencyPath(
  from: { x: number; y: number; edge: 'start' | 'end' },
  to: { x: number; y: number; edge: 'start' | 'end' },
  type: DependencyType
): string {
  // Returns SVG path 'd' attribute
  // Handles routing to avoid bar overlaps
}
```

### Visual Styles

| Type | Line Style | Description |
|------|-----------|-------------|
| FS | Solid | Finish-to-Start (most common) |
| SS | Long dash (6,3) | Start-to-Start |
| FF | Short dash (4,2) | Finish-to-Finish |
| SF | Dot dash (2,2) | Start-to-Finish |

---

## Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 6: Dependencies & Progress | 1.5 weeks | - |
| Phase 7: Auto-Calculation | 1 week | Phase 6 |
| Phase 8: Vacation & Bank Holidays | 1 week | - |
| Phase 9: Staff Workload Heatmap | 0.5 weeks | Phase 8 |
| Phase 10: Phantom & Context Menus | 1 week | Phase 6 |
| Phase 11: Advanced Interactions | 1.5 weeks | - |
| Phase 12: Reordering & Export | 0.5 weeks | - |
| Phase 13: Remaining Modals | 1 week | - |
| Phase 14: Testing & Polish | 1 week | All above |
| Phase 15: Migration & Deployment | 0.5 weeks | Phase 14 |

**Total Remaining: ~9.5 weeks**

---

## Critical Algorithm Documentation

### Auto-Calculation: Parent Date Cascade

This is the core algorithm that maintains data integrity when children are modified:

```
User drags/resizes subphase
         │
         ▼
┌─────────────────────────────┐
│ Update subphase dates       │
│ (API call + optimistic UI)  │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Find parent (phase or       │
│ parent subphase)            │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Calculate min(start) and    │
│ max(end) of all children    │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ If parent dates changed:    │
│ - Update parent             │
│ - Continue to next ancestor │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Reached phase level?        │
│ → Update project dates      │
└─────────────────────────────┘
```

### Workload Heatmap Algorithm

```
For each staff member:
  For each timeline cell (day/week):
    1. Check if cell date falls within any vacation
       → If yes: isOnVacation = true, available = 0
    
    2. Find all assignments active on this date:
       - Project-level assignments
       - Phase-level assignments  
       - Subphase-level assignments
    
    3. Sum allocation percentages
    
    4. Determine visual state:
       - total > 100 → overloaded (red)
       - total === 100 → full (blue solid)
       - total > 0 → partial (blue gradient)
       - isOnVacation && total > 0 → conflict (purple + warning)
```

### Dependency Arrow Path Routing

```typescript
function calculateArrowPath(from, to, type: DependencyType): string {
  const fromX = from.edge === 'end' ? from.barRight : from.barLeft;
  const fromY = from.barCenterY;
  const toX = to.edge === 'start' ? to.barLeft : to.barRight;
  const toY = to.barCenterY;
  
  const minHorizontal = 15; // Minimum horizontal segment
  
  if (type === 'FS') {
    // Finish-to-Start: Exit right, enter left
    if (toX > fromX + minHorizontal) {
      // Target is ahead - simple path
      const midX = fromX + (toX - fromX) / 2;
      return `M${fromX},${fromY} H${midX} V${toY} H${toX}`;
    } else {
      // Target is behind - route around
      const turnY = fromY + (toY > fromY ? 20 : -20);
      return `M${fromX},${fromY} H${fromX + minHorizontal} V${turnY} H${toX - minHorizontal} V${toY} H${toX}`;
    }
  }
  
  if (type === 'SS') {
    // Start-to-Start: Exit left, enter left
    const leftX = Math.min(fromX, toX) - minHorizontal;
    return `M${fromX},${fromY} H${leftX} V${toY} H${toX}`;
  }
  
  if (type === 'FF') {
    // Finish-to-Finish: Exit right, enter right
    const rightX = Math.max(fromX, toX) + minHorizontal;
    return `M${fromX},${fromY} H${rightX} V${toY} H${toX}`;
  }
  
  if (type === 'SF') {
    // Start-to-Finish: Exit left, enter right
    // Complex routing needed
  }
}
```

### ICS File Generation

```typescript
function generateVacationICS(staffName, description, startDate, endDate): string {
  const formatICSDate = (date: string) => date.replace(/-/g, '');
  
  // End date is exclusive for all-day events
  const endDateObj = new Date(endDate);
  endDateObj.setDate(endDateObj.getDate() + 1);
  const endDateICS = formatICSDate(endDateObj.toISOString().split('T')[0]);
  
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Milestone R&D Planning//Vacation Export//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:vacation-${Date.now()}@milestone`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTSTART;VALUE=DATE:${formatICSDate(startDate)}`,
    `DTEND;VALUE=DATE:${endDateICS}`,
    `SUMMARY:${description} - ${staffName}`,
    `DESCRIPTION:Vacation for ${staffName}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'X-MICROSOFT-CDO-BUSYSTATUS:OOF',  // Out of Office
    'X-MICROSOFT-CDO-ALLDAYEVENT:TRUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}
```

---

## Risk Factors

1. **Dependency rendering complexity** - Arrow routing algorithm may need refinement
2. **Performance with many dependencies** - May need virtualization for large projects
3. **Auto-calculation cascading** - Need to prevent infinite loops and handle edge cases
4. **Undo/Redo complexity** - Need careful state management for cascading operations
5. **Browser compatibility** - SVG rendering differences
6. **ICS file encoding** - Different calendar apps may interpret ICS differently
7. **Workload calculation performance** - Large date ranges with many assignments

---

## Data Flow for Auto-Calculation

```
┌─────────────────────────────────────────────────────────────────┐
│                    User Interaction Layer                       │
├─────────────────────────────────────────────────────────────────┤
│  Drag/Resize Hook  │  Modal Save  │  Context Menu Action        │
└─────────┬───────────────┬─────────────────┬─────────────────────┘
          │               │                 │
          ▼               ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Action Dispatcher                            │
│  - Optimistic UI update                                         │
│  - API call                                                     │
│  - Trigger cascade calculation                                  │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cascade Calculator                           │
│  - autoAdjustParentDatesFromChild()                            │
│  - autoAdjustProjectDates()                                     │
│  - Batch API updates for all affected entities                  │
└─────────┬───────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Store Update                                 │
│  - Update Zustand store with new dates                         │
│  - Trigger React re-render                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Next Recommended Step

Start with **Phase 6: Dependencies & Progress** as these are the most impactful missing features for project planning functionality.

Specifically, begin with:
1. Create `DependencyLayer` component (SVG overlay)
2. Implement `calculateDependencyPath` utility
3. Render existing dependencies from project data
4. Add completion bars to phase rendering

Then proceed to **Phase 7: Auto-Calculation** to ensure data integrity when users modify the schedule.

---

## Appendix: Vanilla JS Function Reference

### Key Functions to Port

| Vanilla JS Function | Purpose | React Equivalent |
|---------------------|---------|------------------|
| `renderDependencyArrows()` | Draw SVG arrows | `DependencyLayer` component |
| `autoAdjustParentDatesFromChild()` | Cascade dates up | `useCascadeCalculation` hook |
| `autoAdjustProjectDates()` | Update project from phases | Part of cascade hook |
| `calculateWorkloadPerCell()` | Staff workload heatmap | `useWorkloadCalculation` hook |
| `generateVacationICS()` | Create ICS file | `generateICS` utility |
| `openOutlookWebEvent()` | SSO calendar integration | `openOutlookEvent` utility |
| `startPhantomSiblingMode()` | Ghost phase creation | `usePhantomMode` hook |
| `showPhantomIndicator()` | Lag indicator | Part of phantom hook |
| `createPhantomArrowPath()` | Phantom arrow SVG | Part of `DependencyLayer` |

### API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/vacations` | GET/POST | List/create vacations |
| `/api/vacations/:id` | PUT/DELETE | Update/delete vacation |
| `/api/sites/:id/holidays` | GET | Get bank holidays |
| `/api/sites/:id/holidays/custom` | POST | Add custom holiday |
| `/api/sites/:id/holidays/:id` | DELETE | Delete custom holiday |
| `/api/sites/:id/holidays/refresh` | POST | Refresh from API |
| `/api/phases/:id/dependencies` | POST | Create dependency |
| `/api/dependencies/:id` | PUT/DELETE | Update/delete dependency |
