/**
 * uiStore: modal openers (incl. the legacy aliases that route to the settings
 * hub), editing context, tooltip, drag/resize indicators, phantom sibling,
 * context menu, scroll/zoom triggers and resource drag.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../uiStore';
import { makeEquipment, makeProject, makeStaff, makeUser, makeVacation } from '@/test/factories';

const ui = () => useUIStore.getState();

beforeEach(() => {
  useUIStore.setState(useUIStore.getInitialState());
});

describe('modals', () => {
  it('routes legacy settings modals to the settings hub with the right intent', () => {
    ui().openModal('customHoliday' as never, { siteId: 1 } as never);
    expect(ui()).toMatchObject({
      activeModal: 'settingsHub',
      settingsSection: 'bank-holidays',
      settingsIntent: { type: 'add' },
      modalContext: { siteId: 1 },
    });

    ui().openModal('site' as never);
    expect(ui()).toMatchObject({ activeModal: 'settingsHub', settingsSection: 'sites', settingsIntent: null });

    ui().setActiveModal('ssoConfig' as never);
    expect(ui()).toMatchObject({ activeModal: 'settingsHub', settingsSection: 'sso', settingsIntent: null });

    ui().setActiveModal('project');
    expect(ui().activeModal).toBe('project');
    ui().setActiveModal(null);
    expect(ui().activeModal).toBeNull();
  });

  it('opens and navigates the settings hub', () => {
    ui().openSettings('users', { type: 'add' });
    expect(ui()).toMatchObject({ activeModal: 'settingsHub', settingsSection: 'users', settingsIntent: { type: 'add' } });
    ui().openSettings();
    expect(ui()).toMatchObject({ settingsSection: 'users', settingsIntent: null });
    ui().openSettings(undefined, { type: 'add' });
    ui().clearSettingsIntent();
    expect(ui().settingsIntent).toBeNull();
    ui().setSettingsSection('equipment');
    expect(ui().settingsSection).toBe('equipment');
  });

  it('stores editing context and clears all of it on close', () => {
    const project = makeProject();
    ui().setEditingProject(project);
    ui().setEditingPhase(null);
    ui().setEditingSubphase(null);
    ui().setEditingStaffAssignment(null);
    ui().setEditingEquipmentAssignment(null);
    ui().setEditingVacation(makeVacation());
    ui().setEditingStaff(makeStaff());
    ui().setEditingEquipment(makeEquipment());
    ui().setEditingUser(makeUser());
    expect(ui().editingProject).toBe(project);
    expect(ui().editingVacation?.id).toBe(1);
    expect(ui().editingStaff?.name).toBe('Bob Brown');
    expect(ui().editingEquipment?.name).toBe('Bioreactor 50L');
    expect(ui().editingUser?.email).toBe('ada.admin@demo.local');

    ui().openEquipmentBlockModal(undefined, 7);
    expect(ui()).toMatchObject({ activeModal: 'equipmentBlock', editingEquipmentBlock: null, modalContext: { equipmentId: 7 } });
    ui().openEquipmentBlockModal();
    expect(ui().modalContext).toEqual({});

    ui().closeModal();
    expect(ui()).toMatchObject({
      activeModal: null,
      editingProject: null,
      editingVacation: null,
      editingStaff: null,
      editingEquipment: null,
      editingUser: null,
      modalContext: {},
    });
  });
});

describe('transient UI', () => {
  it('shows and hides the tooltip and the drag/resize indicator', () => {
    ui().showTooltip('Hello', 10, 20);
    expect(ui().tooltip).toEqual({ visible: true, content: 'Hello', x: 10, y: 20 });
    ui().hideTooltip();
    expect(ui().tooltip.visible).toBe(false);

    ui().showResizeIndicator(5, 6, '2026-01-01', 3, 'right' as never);
    expect(ui().dragIndicator).toMatchObject({ visible: true, type: 'resize', date: '2026-01-01', duration: 3 });
    ui().hideIndicator();
    expect(ui().dragIndicator.visible).toBe(false);
  });

  it('moves the phantom sibling only while one is active', () => {
    ui().updatePhantomPosition('2026-01-01', '2026-01-02');
    expect(ui().phantomSiblingMode).toBeNull();
    ui().startPhantomSibling({
      projectId: 1,
      sourceId: 2,
      type: 'phase',
      dependencyType: 'FS',
      phantomStart: '2026-01-05',
      phantomEnd: '2026-01-09',
      phantomColor: '#000',
      siblingDurationDays: 5,
      sourceIndex: 0,
    });
    ui().updatePhantomPosition('2026-02-02', '2026-02-06');
    expect(ui().phantomSiblingMode).toMatchObject({ sourceId: 2, phantomStart: '2026-02-02', phantomEnd: '2026-02-06' });
    ui().endPhantomSibling();
    expect(ui().phantomSiblingMode).toBeNull();
  });

  it('tracks loading and the context menu', () => {
    ui().setLoading(true, 'Saving');
    expect(ui()).toMatchObject({ isLoading: true, loadingMessage: 'Saving' });
    ui().setLoading(false);
    expect(ui().loadingMessage).toBe('');

    ui().showContextMenu('phase' as never, 3, 100, 200, 1, 3);
    expect(ui().contextMenu).toMatchObject({ visible: true, type: 'phase', targetId: 3, x: 100, y: 200, projectId: 1, phaseId: 3 });
    ui().hideContextMenu();
    expect(ui().contextMenu).toMatchObject({ visible: false, type: null, targetId: null, projectId: undefined });
  });

  it('bumps scroll and zoom triggers', () => {
    const before = ui().scrollToTodayTrigger;
    ui().triggerScrollToToday();
    expect(ui().scrollToTodayTrigger).toBe(before + 1);
    ui().triggerScrollToDate('2026-05-01');
    expect(ui().scrollToDateTrigger?.date).toBe('2026-05-01');
    ui().clearScrollToDateTrigger();
    expect(ui().scrollToDateTrigger).toBeNull();
    ui().triggerZoom('in' as never, 60);
    expect(ui().zoomTrigger).toMatchObject({ direction: 'in', newCellWidth: 60 });
    ui().clearZoomTrigger();
    expect(ui().zoomTrigger).toBeNull();
  });

  it('runs a resource drag from start to target to end', () => {
    ui().startResourceDrag('staff', 4, 'Bob Brown');
    expect(ui().resourceDrag).toMatchObject({ active: true, type: 'staff', resourceId: 4, resourceName: 'Bob Brown', targetProjectId: null });
    ui().updateResourceDragTarget(1, 2, null, '2026-01-01', '2026-01-05');
    expect(ui().resourceDrag).toMatchObject({ active: true, targetProjectId: 1, targetPhaseId: 2, previewEnd: '2026-01-05' });
    ui().endResourceDrag();
    expect(ui().resourceDrag).toMatchObject({ active: false, type: null, resourceId: null, previewStart: null });
  });
});
