import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Download,
  Printer,
  Search,
  XCircle,
} from 'lucide-react';
import {
  ActivityCategory,
  CATEGORY_META,
  CATEGORY_ORDER,
  SchoolClass,
} from '../types';
import {
  evaluateStudent,
  formatShortDate,
  sortStudentsAlphabetically,
} from '../utils/calculations';
import { exportResocontoToExcel } from '../utils/excelExport';

interface ResocontoViewProps {
  classes: SchoolClass[];
  onOpenClass: (classId: string) => void;
}

export const ResocontoView: React.FC<ResocontoViewProps> = ({
  classes,
  onOpenClass,
}) => {
  const [selectedClassId, setSelectedClassId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'CARENZA' | 'OK'>(
    'ALL'
  );
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | 'ALL'>(
    'ALL'
  );
  const [searchQuery, setSearchQuery] = useState('');

  // All evaluations across selected class(es)
  const baseEvaluations = useMemo(() => {
    const targetClasses =
      selectedClassId === 'ALL'
        ? classes
        : classes.filter((c) => c.id === selectedClassId);

    return targetClasses.flatMap((cls) =>
      sortStudentsAlphabetically(cls.students).map((stu) =>
        evaluateStudent(stu, cls)
      )
    );
  }, [classes, selectedClassId]);

  // Summary KPIs for the current class scope
  const summaryStats = useMemo(() => {
    const total = baseEvaluations.length;
    const met = baseEvaluations.filter((e) => e.allRequirementsMet).length;
    const deficient = total - met;
    const totalMissingProofs = baseEvaluations.reduce(
      (sum, e) => sum + e.totalMissing,
      0
    );
    const totalAbsences = baseEvaluations.reduce(
      (sum, e) => sum + e.totalAbsent,
      0
    );
    return {
      total,
      met,
      deficient,
      totalMissingProofs,
      totalAbsences,
    };
  }, [baseEvaluations]);

  // Filtered list shown in report table
  const filteredEvaluations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return baseEvaluations.filter((ev) => {
      if (q) {
        const full = `${ev.student.lastName} ${ev.student.firstName}`.toLowerCase();
        const rev = `${ev.student.firstName} ${ev.student.lastName}`.toLowerCase();
        const clsName = ev.schoolClass.name.toLowerCase();
        if (!full.includes(q) && !rev.includes(q) && !clsName.includes(q)) {
          return false;
        }
      }

      if (categoryFilter === 'ALL') {
        if (statusFilter === 'CARENZA' && ev.allRequirementsMet) return false;
        if (statusFilter === 'OK' && !ev.allRequirementsMet) return false;
      } else {
        const catMet = ev.byCategory[categoryFilter].met;
        if (statusFilter === 'CARENZA' && catMet) return false;
        if (statusFilter === 'OK' && !catMet) return false;
      }

      return true;
    });
  }, [baseEvaluations, searchQuery, statusFilter, categoryFilter]);

  const handleExportExcel = () => {
    const label =
      selectedClassId === 'ALL'
        ? 'tutte-le-classi'
        : `classe-${
            classes
              .find((c) => c.id === selectedClassId)
              ?.name.replace(/\s+/g, '_') || 'selezione'
          }`;
    exportResocontoToExcel(filteredEvaluations, label);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-2.5 px-2.5 py-2.5 sm:px-4 sm:py-3">
      {/* Compact Synthetic Overview Strip (4 columns, single hairline bar) */}
      <div className="grid grid-cols-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="flex items-baseline justify-between gap-2 px-3.5 py-2">
          <span className="text-xs font-medium text-slate-500">Studenti</span>
          <span className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
            {summaryStats.total}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-2 px-3.5 py-2">
          <span className="text-xs font-medium text-emerald-700">In regola</span>
          <span className="font-mono text-lg font-semibold text-emerald-700 tabular-nums">
            {summaryStats.met}
            {summaryStats.total > 0 && (
              <span className="ml-1 text-[11px] font-normal text-slate-500">
                ({Math.round((summaryStats.met / summaryStats.total) * 100)}%)
              </span>
            )}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-2 px-3.5 py-2">
          <span className="text-xs font-medium text-amber-800">Con carenze</span>
          <span className="font-mono text-lg font-semibold text-amber-700 tabular-nums">
            {summaryStats.deficient}
            {summaryStats.total > 0 && (
              <span className="ml-1 text-[11px] font-normal text-slate-500">
                ({Math.round((summaryStats.deficient / summaryStats.total) * 100)}%)
              </span>
            )}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-2 px-3.5 py-2">
          <span className="text-xs font-medium text-slate-500">Mancanti / Ass.</span>
          <span className="font-mono text-lg font-semibold text-slate-900 tabular-nums">
            {summaryStats.totalMissingProofs}
            <span className="mx-1 text-xs font-normal text-slate-400">/</span>
            <span className="text-sm font-medium text-amber-700">
              {summaryStats.totalAbsences}
            </span>
          </span>
        </div>
      </div>

      {/* Single Compact Filters & Actions Bar */}
      <div className="no-print flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filtra per classe"
            value={selectedClassId}
            onChange={(e) => setSelectedClassId(e.target.value)}
            className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-800 focus:border-blue-600 focus:outline-none"
          >
            <option value="ALL">Tutte le classi ({classes.length})</option>
            {classes.map((cls) => (
              <option key={cls.id} value={cls.id}>
                Classe {cls.name} ({cls.students.length})
              </option>
            ))}
          </select>

          <select
            aria-label="Filtra per stato"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as 'ALL' | 'CARENZA' | 'OK')
            }
            className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-800 focus:border-blue-600 focus:outline-none"
          >
            <option value="ALL">Tutti gli studenti</option>
            <option value="CARENZA">Solo con carenze</option>
            <option value="OK">Solo in regola</option>
          </select>

          <select
            aria-label="Filtra per categoria"
            value={categoryFilter}
            onChange={(e) =>
              setCategoryFilter(e.target.value as ActivityCategory | 'ALL')
            }
            className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-800 focus:border-blue-600 focus:outline-none"
          >
            <option value="ALL">Tutte le categorie</option>
            {CATEGORY_ORDER.map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_META[cat].pluralLabel}
              </option>
            ))}
          </select>

          <div className="relative w-40 sm:w-48">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cerca studente..."
              className="h-8 w-full rounded-md border border-slate-300 bg-white pl-8 pr-2.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => window.print()}
            title="Stampa resoconto"
            aria-label="Stampa resoconto"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
          >
            <Printer className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Stampa</span>
          </button>
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={filteredEvaluations.length === 0}
            title="Esporta resoconto in Excel"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-700 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Excel</span>
          </button>
        </div>
      </div>

      {/* Compact Report Table */}
      <div className="register-scroll flex-1 overflow-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[740px] border-collapse text-left text-xs sm:text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr className="border-b border-slate-200 text-xs font-semibold text-slate-600">
              <th className="w-16 px-3 py-2">Classe</th>
              <th className="w-44 px-3 py-2">Studente</th>
              <th className="px-2.5 py-2">Grafici</th>
              <th className="px-2.5 py-2">Orali</th>
              <th className="px-2.5 py-2">Pratici</th>
              <th className="px-3 py-2">Carenze e recuperi</th>
              <th className="w-28 px-3 py-2">Stato</th>
              <th className="no-print w-16 px-2.5 py-2 text-right">Apri</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredEvaluations.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-6 py-10 text-center text-sm text-slate-500"
                >
                  {classes.length === 0
                    ? 'Nessuna classe presente in archivio.'
                    : 'Nessuno studente corrisponde ai criteri selezionati.'}
                </td>
              </tr>
            ) : (
              filteredEvaluations.map((ev) => {
                const relevantMissed =
                  categoryFilter === 'ALL'
                    ? ev.missedActivities
                    : ev.missedActivities.filter(
                        (m) => m.category === categoryFilter
                      );

                return (
                  <tr
                    key={`${ev.schoolClass.id}-${ev.student.id}`}
                    className={`transition-colors ${
                      ev.allRequirementsMet
                        ? 'bg-white hover:bg-emerald-50/35'
                        : 'bg-white hover:bg-amber-50/35'
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-xs font-semibold text-slate-700">
                      {ev.schoolClass.name}
                    </td>

                    <td className="px-3 py-2 text-[13px] font-medium text-slate-900">
                      {ev.student.lastName}{' '}
                      <span className="font-normal text-slate-700">
                        {ev.student.firstName}
                      </span>
                    </td>

                    {CATEGORY_ORDER.map((cat) => {
                      const catEv = ev.byCategory[cat];
                      const dimmed =
                        categoryFilter !== 'ALL' && categoryFilter !== cat;
                      return (
                        <td
                          key={cat}
                          className={`px-2.5 py-2 whitespace-nowrap ${dimmed ? 'opacity-40' : ''}`}
                        >
                          <div className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
                            <span className="font-semibold text-slate-900">
                              {catEv.completedTotal}/{catEv.minimum}
                            </span>
                            <span
                              className={`font-sans text-[11px] font-semibold ${
                                catEv.met
                                  ? 'text-emerald-700'
                                  : 'text-amber-800'
                              }`}
                            >
                              {catEv.met ? 'OK' : `-${catEv.missing}`}
                            </span>
                          </div>
                        </td>
                      );
                    })}

                    <td className="px-3 py-2 text-xs">
                      {ev.allRequirementsMet ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="font-medium text-slate-900">
                          {ev.deficitSummary}
                        </div>
                      )}

                      {relevantMissed.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-slate-600">
                          {relevantMissed.slice(0, 3).map((m) => (
                            <span
                              key={m.activityId}
                              className="inline-flex items-center gap-1"
                            >
                              {m.status === 'ASSENTE' ? (
                                <Clock className="h-3 w-3 text-amber-600" />
                              ) : (
                                <XCircle className="h-3 w-3 text-rose-600" />
                              )}
                              <span>
                                {m.status === 'ASSENTE' ? 'Ass.' : 'Non sv.'}:{' '}
                                {m.title} ({formatShortDate(m.date)})
                              </span>
                            </span>
                          ))}
                          {relevantMissed.length > 3 && (
                            <span className="text-slate-400">
                              +{relevantMissed.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap">
                      {ev.allRequirementsMet ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          In regola
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800">
                          <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                          Carenza
                        </span>
                      )}
                    </td>

                    <td className="no-print px-2.5 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenClass(ev.schoolClass.id)}
                        title={`Apri registro classe ${ev.schoolClass.name}`}
                        aria-label={`Apri registro classe ${ev.schoolClass.name}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-blue-700 transition-colors hover:bg-blue-50"
                      >
                        <ArrowUpRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
