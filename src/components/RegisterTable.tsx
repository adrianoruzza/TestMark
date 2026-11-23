import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  History,
  Minus,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  XCircle,
} from 'lucide-react';
import {
  Activity,
  ActivityCategory,
  CATEGORY_META,
  CATEGORY_ORDER,
  CompletionStatus,
  STATUS_META,
  SchoolClass,
  Student,
} from '../types';
import {
  evaluateStudent,
  formatFullDate,
  formatShortDate,
  getStudentStatus,
  sortActivitiesChronologically,
  sortStudentsAlphabetically,
} from '../utils/calculations';

interface RegisterTableProps {
  schoolClass: SchoolClass;
  searchQuery: string;
  categoryFilter: ActivityCategory | 'ALL';
  requirementFilter: 'ALL' | 'OK' | 'CARENZA';
  onUpdateStatus: (
    studentId: string,
    activityId: string,
    status: CompletionStatus
  ) => void;
  onBulkSetActivityStatus: (
    activityId: string,
    status: CompletionStatus,
    onlyPending: boolean
  ) => void;
  onEditActivity: (activity: Activity) => void;
  onRequestDeleteActivity: (activity: Activity) => void;
  onOpenStudentHistory: (student: Student) => void;
  onOpenMoveCopyStudent: (studentId: string) => void;
  onAddActivity: () => void;
  onAddStudent: () => void;
}

const CYCLE_ORDER: CompletionStatus[] = [
  'PENDENTE',
  'SVOLTO',
  'ASSENTE',
  'NON_SVOLTO',
];

function getNextStatus(current: CompletionStatus): CompletionStatus {
  const idx = CYCLE_ORDER.indexOf(current);
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
}

export const RegisterTable: React.FC<RegisterTableProps> = ({
  schoolClass,
  searchQuery,
  categoryFilter,
  requirementFilter,
  onUpdateStatus,
  onBulkSetActivityStatus,
  onEditActivity,
  onRequestDeleteActivity,
  onOpenStudentHistory,
  onOpenMoveCopyStudent,
  onAddActivity,
  onAddStudent,
}) => {
  const [openCellMenu, setOpenCellMenu] = useState<{
    studentId: string;
    activityId: string;
  } | null>(null);
  const [openHeaderMenu, setOpenHeaderMenu] = useState<string | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-cell-popover]') && !target.closest('[data-cell-trigger]')) {
        setOpenCellMenu(null);
      }
      if (!target.closest('[data-header-menu]') && !target.closest('[data-header-trigger]')) {
        setOpenHeaderMenu(null);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenCellMenu(null);
        setOpenHeaderMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const sortedActivities = useMemo(() => {
    const chronological = sortActivitiesChronologically(schoolClass.activities);
    if (categoryFilter === 'ALL') return chronological;
    return chronological.filter((a) => a.category === categoryFilter);
  }, [schoolClass.activities, categoryFilter]);

  const evaluatedStudents = useMemo(() => {
    const alphabetical = sortStudentsAlphabetically(schoolClass.students);
    const q = searchQuery.trim().toLowerCase();

    return alphabetical
      .map((student, originalIndex) => ({
        student,
        originalIndex: originalIndex + 1,
        evaluation: evaluateStudent(student, schoolClass),
      }))
      .filter(({ student, evaluation }) => {
        if (q) {
          const full = `${student.lastName} ${student.firstName}`.toLowerCase();
          const rev = `${student.firstName} ${student.lastName}`.toLowerCase();
          if (!full.includes(q) && !rev.includes(q)) return false;
        }
        if (requirementFilter === 'OK' && !evaluation.allRequirementsMet) return false;
        if (requirementFilter === 'CARENZA' && evaluation.allRequirementsMet) return false;
        return true;
      });
  }, [schoolClass, searchQuery, requirementFilter]);

  const handleCellKeyDown = (
    e: React.KeyboardEvent,
    studentId: string,
    activityId: string,
    currentStatus: CompletionStatus
  ) => {
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      onUpdateStatus(studentId, activityId, 'SVOLTO');
    } else if (key === 'a') {
      e.preventDefault();
      onUpdateStatus(studentId, activityId, 'ASSENTE');
    } else if (key === 'n') {
      e.preventDefault();
      onUpdateStatus(studentId, activityId, 'NON_SVOLTO');
    } else if (key === 'backspace' || key === 'delete' || key === '0') {
      e.preventDefault();
      onUpdateStatus(studentId, activityId, 'PENDENTE');
    } else if (key === ' ' || key === 'enter') {
      e.preventDefault();
      onUpdateStatus(studentId, activityId, getNextStatus(currentStatus));
    }
  };

  if (schoolClass.students.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-slate-200 bg-white px-6 py-16 text-center">
        <h3 className="text-base font-semibold text-slate-900">
          Nessuno studente inserito nella classe {schoolClass.name}
        </h3>
        <p className="mt-1.5 max-w-md text-sm text-slate-500">
          Aggiungi gli studenti manualmente oppure importa rapidamente l&apos;elenco da un file Excel (.xlsx), Word (.docx) o di testo (.txt).
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onAddStudent}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 whitespace-nowrap"
          >
            <UserPlus className="h-4 w-4" />
            Aggiungi o importa studenti
          </button>
          <button
            type="button"
            onClick={onAddActivity}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            Aggiungi attività
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div
        ref={tableContainerRef}
        className="register-scroll relative flex-1 overflow-auto"
      >
        <table className="w-max min-w-full border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr>
              {/* Sticky Top-Left: Student column */}
              <th
                scope="col"
                className="sticky left-0 top-0 z-30 w-[178px] min-w-[168px] max-w-[196px] border-b border-r border-slate-200 bg-slate-50 px-2.5 py-2 align-bottom shadow-[1px_0_0_0_#e2e8f0] sm:w-[218px] sm:min-w-[205px] sm:max-w-[240px] sm:px-3"
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900">
                      Studente
                    </div>
                    <div className="text-[11px] font-normal text-slate-500 tabular-nums">
                      {evaluatedStudents.length}/{schoolClass.students.length}
                    </div>
                  </div>
                  <span className="font-mono text-[10px] font-medium text-slate-400">
                    N.
                  </span>
                </div>
              </th>

              {/* Chronological Activity Columns */}
              {sortedActivities.length === 0 ? (
                <th
                  scope="col"
                  className="sticky top-0 z-20 min-w-[240px] border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-center align-middle"
                >
                  <div className="flex items-center justify-center gap-2.5 text-xs font-normal text-slate-500">
                    <span>
                      {categoryFilter === 'ALL'
                        ? 'Nessuna attività registrata.'
                        : `Nessuna attività in ${CATEGORY_META[categoryFilter].label}.`}
                    </span>
                    <button
                      type="button"
                      onClick={onAddActivity}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Attività
                    </button>
                  </div>
                </th>
              ) : (
                sortedActivities.map((activity) => {
                  const catMeta = CATEGORY_META[activity.category];
                  const isMenuOpen = openHeaderMenu === activity.id;
                  const svoltoCount = schoolClass.students.filter(
                    (s) => getStudentStatus(s, activity.id) === 'SVOLTO'
                  ).length;

                  return (
                    <th
                      key={activity.id}
                      scope="col"
                      className={`sticky top-0 z-20 w-[124px] min-w-[116px] max-w-[144px] border-b-2 border-r border-r-slate-200 px-2 py-1.5 align-top sm:w-[136px] ${catMeta.headerBg} ${catMeta.headerBorder}`}
                    >
                      <div className="relative flex flex-col gap-0.5">
                        <div className="flex items-center justify-between gap-1">
                          <span
                            className={`truncate text-[10px] font-semibold ${catMeta.headerText}`}
                          >
                            {catMeta.shortLabel}
                          </span>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <span className="font-mono text-[10px] font-medium text-slate-500 tabular-nums">
                              {formatShortDate(activity.date)}
                            </span>
                            <button
                              type="button"
                              data-header-trigger
                              onClick={() =>
                                setOpenHeaderMenu(isMenuOpen ? null : activity.id)
                              }
                              className="rounded p-0.5 text-slate-500 transition-colors hover:bg-white/80 hover:text-slate-900"
                              aria-label={`Azioni per ${activity.title}`}
                              title="Opzioni attività"
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => onEditActivity(activity)}
                          title={`${activity.title} (${formatFullDate(activity.date)})${
                            activity.notes ? ` — Note: ${activity.notes}` : ''
                          }`}
                          className="line-clamp-2 text-left text-[11px] font-semibold leading-tight text-slate-900 hover:text-blue-800 sm:text-xs"
                        >
                          {activity.title}
                        </button>

                        <div className="flex items-center justify-between gap-1 text-[10px] font-normal text-slate-500">
                          <span className="font-mono tabular-nums">
                            {svoltoCount}/{schoolClass.students.length}
                          </span>
                          {activity.notes && (
                            <span
                              title={`Note: ${activity.notes}`}
                              className="text-slate-400"
                            >
                              <FileText className="h-3 w-3" />
                            </span>
                          )}
                        </div>

                        {/* Activity Column Action Menu */}
                        {isMenuOpen && (
                          <div
                            data-header-menu
                            className="absolute right-0 top-6 z-40 w-48 rounded-lg border border-slate-200 bg-white py-1 text-xs font-normal text-slate-700 shadow-lg"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setOpenHeaderMenu(null);
                                onEditActivity(activity);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                            >
                              <Pencil className="h-3.5 w-3.5 text-slate-500" />
                              Modifica o rinomina
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenHeaderMenu(null);
                                onBulkSetActivityStatus(activity.id, 'SVOLTO', true);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-emerald-50 hover:text-emerald-900"
                            >
                              <Check className="h-3.5 w-3.5 text-emerald-600" />
                              Pendenti come Svolti
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setOpenHeaderMenu(null);
                                onBulkSetActivityStatus(activity.id, 'PENDENTE', false);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
                            >
                              <Minus className="h-3.5 w-3.5 text-slate-500" />
                              Azzera colonna
                            </button>
                            <div className="my-1 border-t border-slate-100" />
                            <button
                              type="button"
                              onClick={() => {
                                setOpenHeaderMenu(null);
                                onRequestDeleteActivity(activity);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-700 hover:bg-rose-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Elimina attività
                            </button>
                          </div>
                        )}
                      </div>
                    </th>
                  );
                })
              )}

              {/* Sticky Top-Right: Riepilogo column */}
              <th
                scope="col"
                className="sticky right-0 top-0 z-30 w-[184px] min-w-[178px] border-b border-l border-slate-200 bg-slate-50 px-2.5 py-2 align-bottom shadow-[-1px_0_0_0_#e2e8f0] sm:w-[228px] sm:min-w-[220px] sm:px-3"
              >
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-900">
                      Riepilogo
                    </span>
                    <span className="text-[10px] font-medium text-slate-500">
                      Esito
                    </span>
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px] font-normal text-slate-500 tabular-nums">
                    <span title="Minimo Compiti grafici">
                      G:{schoolClass.minimums.COMPITO_GRAFICO}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span title="Minimo Interrogazioni orali">
                      O:{schoolClass.minimums.INTERROGAZIONE_ORALE}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span title="Minimo Consegne pratiche">
                      P:{schoolClass.minimums.CONSEGNA_PRATICO}
                    </span>
                  </div>
                </div>
              </th>
            </tr>
          </thead>

          <tbody>
            {evaluatedStudents.length === 0 ? (
              <tr>
                <td
                  colSpan={sortedActivities.length + 2}
                  className="px-6 py-10 text-center text-sm text-slate-500"
                >
                  Nessuno studente corrisponde ai filtri applicati.
                </td>
              </tr>
            ) : (
              evaluatedStudents.map(({ student, originalIndex, evaluation }) => {
                const rowAllMet = evaluation.allRequirementsMet;
                return (
                  <tr key={student.id} className="group">
                    {/* Sticky Left: Student Number & Name */}
                    <td
                      className={`sticky left-0 z-10 border-b border-r border-slate-200 px-2.5 py-1 shadow-[1px_0_0_0_#e2e8f0] transition-colors sm:px-3 ${
                        rowAllMet
                          ? 'bg-emerald-50/45 group-hover:bg-emerald-50/80'
                          : 'bg-white group-hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                          <span className="w-5 shrink-0 font-mono text-[11px] text-slate-400 tabular-nums">
                            {originalIndex}.
                          </span>
                          <button
                            type="button"
                            onClick={() => onOpenStudentHistory(student)}
                            className="min-h-[34px] truncate text-left text-[13px] font-medium text-slate-900 hover:text-blue-700 focus:outline-none focus-visible:underline"
                            title={`Apri scheda e storico di ${student.lastName} ${student.firstName}`}
                          >
                            <span>{student.lastName}</span>{' '}
                            <span className="font-normal text-slate-700">
                              {student.firstName}
                            </span>
                          </button>
                          {student.archivedHistory.length > 0 && (
                            <button
                              type="button"
                              onClick={() => onOpenStudentHistory(student)}
                              title={`${student.archivedHistory.length} attività nello storico`}
                              className="shrink-0 text-slate-400 hover:text-blue-700"
                            >
                              <History className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>

                        <div className="hidden shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 lg:flex">
                          <button
                            type="button"
                            onClick={() => onOpenMoveCopyStudent(student.id)}
                            title="Sposta o copia in un'altra classe"
                            className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
                          >
                            <ArrowRightLeft className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenStudentHistory(student)}
                            title="Modifica o visualizza storico"
                            className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </td>

                    {/* Activity Status Cells */}
                    {sortedActivities.length === 0 ? (
                      <td className="border-b border-r border-slate-200 bg-slate-50/30 px-3 py-1.5 text-center text-xs text-slate-400">
                        —
                      </td>
                    ) : (
                      sortedActivities.map((activity) => {
                        const status = getStudentStatus(student, activity.id);
                        const statusMeta = STATUS_META[status];
                        const isPopoverOpen =
                          openCellMenu?.studentId === student.id &&
                          openCellMenu?.activityId === activity.id;

                        return (
                          <td
                            key={activity.id}
                            className="relative border-b border-r border-slate-200 p-1 align-middle"
                          >
                            <div className="group/cell relative flex items-center">
                              <button
                                type="button"
                                onClick={() =>
                                  onUpdateStatus(
                                    student.id,
                                    activity.id,
                                    getNextStatus(status)
                                  )
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setOpenCellMenu({
                                    studentId: student.id,
                                    activityId: activity.id,
                                  });
                                }}
                                onKeyDown={(e) =>
                                  handleCellKeyDown(e, student.id, activity.id, status)
                                }
                                title={`${student.lastName} ${student.firstName} · ${activity.title}: ${statusMeta.label}`}
                                className={`flex h-9 w-full items-center justify-center gap-1 rounded-md border pl-1.5 pr-5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${statusMeta.cellBg} ${statusMeta.cellHover} ${statusMeta.cellText} ${statusMeta.cellBorder}`}
                              >
                                {status === 'SVOLTO' && (
                                  <Check className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {status === 'ASSENTE' && (
                                  <Clock className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {status === 'NON_SVOLTO' && (
                                  <XCircle className="h-3.5 w-3.5 shrink-0" />
                                )}
                                <span className="truncate">{statusMeta.shortLabel}</span>
                              </button>

                              {/* Touch-accessible direct state picker trigger */}
                              <button
                                type="button"
                                data-cell-trigger
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenCellMenu(
                                    isPopoverOpen
                                      ? null
                                      : { studentId: student.id, activityId: activity.id }
                                  );
                                }}
                                aria-label="Scegli stato direttamente"
                                title="Scelta diretta stato"
                                className="absolute right-0.5 top-1/2 flex h-7 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-500/75 transition-opacity hover:bg-black/5 hover:text-slate-900 sm:opacity-45 sm:group-hover/cell:opacity-100 focus:opacity-100"
                              >
                                <ChevronDown className="h-3 w-3" />
                              </button>
                            </div>

                            {/* Direct Status Picker Popover */}
                            {isPopoverOpen && (
                              <div
                                data-cell-popover
                                className="absolute left-1/2 top-11 z-40 w-40 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
                              >
                                {(
                                  ['SVOLTO', 'ASSENTE', 'NON_SVOLTO', 'PENDENTE'] as CompletionStatus[]
                                ).map((opt) => {
                                  const m = STATUS_META[opt];
                                  const active = status === opt;
                                  return (
                                    <button
                                      key={opt}
                                      type="button"
                                      onClick={() => {
                                        onUpdateStatus(student.id, activity.id, opt);
                                        setOpenCellMenu(null);
                                      }}
                                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                                        active
                                          ? 'bg-slate-100 text-slate-900'
                                          : 'text-slate-700 hover:bg-slate-50'
                                      }`}
                                    >
                                      <span className="flex items-center gap-2">
                                        <span
                                          className={`h-2.5 w-2.5 rounded-sm border ${m.cellBg} ${m.cellBorder}`}
                                        />
                                        {m.label}
                                      </span>
                                      {active && (
                                        <Check className="h-3 w-3 text-blue-700" />
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        );
                      })
                    )}

                    {/* Sticky Right: Riepilogo column */}
                    <td
                      className={`sticky right-0 z-10 border-b border-l border-slate-200 px-2 py-1 shadow-[-1px_0_0_0_#e2e8f0] transition-colors sm:px-2.5 ${
                        rowAllMet
                          ? 'bg-emerald-50/75 group-hover:bg-emerald-100/60'
                          : 'bg-white group-hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        {/* Per-category ratios */}
                        <div className="flex items-center gap-1 font-mono text-[11px] tabular-nums">
                          {CATEGORY_ORDER.map((cat) => {
                            const catEval = evaluation.byCategory[cat];
                            const meta = CATEGORY_META[cat];
                            return (
                              <span
                                key={cat}
                                title={`${meta.pluralLabel}: ${catEval.completedTotal}/${catEval.minimum} svolti${
                                  catEval.completedArchived > 0 &&
                                  schoolClass.includeArchivedInCount
                                    ? ` (incl. ${catEval.completedArchived} storico)`
                                    : ''
                                } · Assenze: ${catEval.absentCount} · Non svolti: ${catEval.notDoneCount}`}
                                className={`rounded px-1 py-0.5 text-[10px] font-semibold sm:px-1.5 sm:text-[11px] ${
                                  catEval.met
                                    ? 'bg-emerald-100/80 text-emerald-900'
                                    : 'bg-amber-100/90 text-amber-900'
                                }`}
                              >
                                {meta.code}:{catEval.completedTotal}/{catEval.minimum}
                              </span>
                            );
                          })}
                        </div>

                        {/* Overall status indicator (color + text + icon) */}
                        {rowAllMet ? (
                          <div
                            className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-800"
                            title="Tutti i requisiti minimi raggiunti"
                          >
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            <span className="hidden sm:inline">OK</span>
                          </div>
                        ) : (
                          <div
                            className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-amber-800"
                            title={`Carenza: ${evaluation.deficitSummary}`}
                          >
                            <AlertCircle className="h-4 w-4 text-amber-600" />
                            <span className="font-mono text-[11px] tabular-nums">
                              -{evaluation.totalMissing}
                            </span>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Compact bottom legend strip inside table frame */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50/90 px-3 py-1 text-[11px] text-slate-600">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-emerald-400 bg-emerald-200" />
            Svolto
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-amber-400 bg-amber-200" />
            Assente
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-rose-400 bg-rose-200" />
            Non svolto
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-slate-300 bg-white" />
            Non registrato
          </span>
        </div>
        <div className="hidden text-slate-500 md:block">
          Clic/tocco: cicla stato · ▾ o tasto destro: scelta diretta · S/A/N/Canc
        </div>
      </div>
    </div>
  );
};
