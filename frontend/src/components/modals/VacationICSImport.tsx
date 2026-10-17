/**
 * VacationICSImport - import absences for one staff member from an .ics file
 *
 * Wraps the shared ICSImportPanel with the vacation specifics: a default
 * absence type, a per-row type override (pre-filled from Outlook's
 * BUSYSTATUS or a CATEGORIES/SUMMARY match on a type name), duplicate flags
 * against existing absences, and one POST /vacations/import.
 *
 * Used by VacationModal (import mode) and MyAbsencesModal.
 */

import { useState, useMemo, useCallback } from 'react';
import { ICSImportPanel, ICS_IMPORT_WHAT_IF_MESSAGE } from '@/components/common/ICSImportPanel';
import type { ICSImportRow } from '@/components/common/ICSImportPanel';
import { useAppStore } from '@/stores/appStore';
import { useWhatIfStore } from '@/stores/whatIfStore';
import { importVacations, getVacations } from '@/api/endpoints/vacations';
import { defaultAbsenceTypeId, guessAbsenceTypeId } from '@/utils/recurringVacation';
import { clampText } from '@/utils/ics';
import type { ParsedICSEvent } from '@/utils/ics';
import type { CalendarImportResult } from '@/types';
import { AbsenceTypeSelect } from './AbsenceTypeSelect';
import styles from './VacationICSImport.module.css';

/**
 * Per-row absence type: a type id (or null = untyped) chosen for this row, or
 * undefined to follow the "default type" select above the table.
 */
type RowAbsenceType = number | null | undefined;

interface VacationICSImportProps {
  /** Staff member the absences are imported for; null disables the panel */
  staffId: number | null;
  onImported?: (result: CalendarImportResult) => void;
}

export function VacationICSImport({ staffId, onImported }: VacationICSImportProps) {
  const absenceTypes = useAppStore((s) => s.absenceTypes);
  const vacations = useAppStore((s) => s.vacations);
  const setVacations = useAppStore((s) => s.setVacations);
  const whatIfMode = useWhatIfStore((s) => s.whatIfMode);

  // undefined until the user picks one: follow the configured default
  const [chosenDefaultTypeId, setDefaultTypeId] = useState<number | null | undefined>(undefined);
  const defaultTypeId =
    chosenDefaultTypeId === undefined ? defaultAbsenceTypeId(absenceTypes) : chosenDefaultTypeId;

  // Existing (start, end) pairs of this staff member, for duplicate flags
  const existingRanges = useMemo(() => {
    const set = new Set<string>();
    for (const v of vacations) {
      if (v.staff_id === staffId) {
        set.add(`${v.start_date.split('T')[0]}|${v.end_date.split('T')[0]}`);
      }
    }
    return set;
  }, [vacations, staffId]);

  const isDuplicate = useCallback(
    (event: ParsedICSEvent) => existingRanges.has(`${event.start_date}|${event.end_date}`),
    [existingRanges]
  );

  // A recognised type is pinned to the row; anything else follows the default.
  const initExtra = useCallback(
    (event: ParsedICSEvent): RowAbsenceType => guessAbsenceTypeId(event, absenceTypes) ?? undefined,
    [absenceTypes]
  );

  const renderRowExtra = useCallback(
    (row: ICSImportRow<RowAbsenceType>, setExtra: (extra: RowAbsenceType) => void) => (
      <AbsenceTypeSelect
        compact
        value={row.extra === undefined ? defaultTypeId : row.extra}
        onChange={setExtra}
        types={absenceTypes}
        aria-label={`Absence type for ${row.summary || 'untitled event'} (${row.start_date})`}
      />
    ),
    [absenceTypes, defaultTypeId]
  );

  const handleImport = useCallback(
    async (rows: ICSImportRow<RowAbsenceType>[]): Promise<CalendarImportResult> => {
      if (!staffId) throw new Error('No staff member selected');
      const result = await importVacations(
        staffId,
        rows.map((row) => {
          const typeId = row.extra === undefined ? defaultTypeId : row.extra;
          const typeName = absenceTypes.find((t) => t.id === typeId)?.name;
          return {
            start_date: row.start_date,
            end_date: row.end_date,
            // The backend caps descriptions at 200 chars; one long SUMMARY must not fail the import
            description: clampText(row.summary) || typeName || 'Vacation',
            absence_type_id: typeId,
          };
        })
      );
      setVacations(await getVacations());
      return result;
    },
    [staffId, defaultTypeId, absenceTypes, setVacations]
  );

  const disabledReason = whatIfMode
    ? ICS_IMPORT_WHAT_IF_MESSAGE
    : !staffId
      ? 'Select a staff member first.'
      : null;

  return (
    <div className={styles.container}>
      {absenceTypes.length > 0 && (
        <div className={styles.defaultType}>
          <label className={styles.label} htmlFor="vacation-import-default-type">
            Default absence type
          </label>
          <div className={styles.defaultSelect}>
            <AbsenceTypeSelect
              id="vacation-import-default-type"
              value={defaultTypeId}
              onChange={setDefaultTypeId}
              types={absenceTypes}
            />
          </div>
          <p className={styles.help}>
            Applies to every row not recognised from the file (Outlook "working elsewhere" entries
            become Home Office; categories or titles matching a type name use that type).
          </p>
        </div>
      )}
      <ICSImportPanel<RowAbsenceType>
        itemLabel="absence"
        hint="Import absences from Outlook or any calendar app that exports .ics files"
        isDuplicate={isDuplicate}
        initExtra={initExtra}
        renderRowExtra={renderRowExtra}
        extraColumnLabel="Type"
        onImport={handleImport}
        onImported={onImported}
        disabledReason={disabledReason}
      />
    </div>
  );
}
