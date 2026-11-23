import React, { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  CheckCircle2,
  AlertCircle,
  History,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  STATUS_META,
  SchoolClass,
  Student,
} from '../types';
import {
  evaluateStudent,
  formatFullDate,
  getStudentStatus,
  sortActivitiesChronologically,
} from '../utils/calculations';

interface StudentHistoryModalProps {
  open: boolean;
  student: Student | null;
  schoolClass: SchoolClass | null;
  onUpdateStudent: (
    studentId: string,
    payload: { lastName: string; firstName: string; notes: string }
  ) => void;
  onOpenMoveCopy: (studentId: string) => void;
  onRequestDeleteStudent: (student: Student) => void;
  onDeleteArchivedEntry: (studentId: string, archivedEntryId: string) => void;
  onClose: () => void;
}

export const StudentHistoryModal: React.FC<StudentHistoryModalProps> = ({
  open,
  student,
  schoolClass,
  onUpdateStudent,
  onOpenMoveCopy,
  onRequestDeleteStudent,
  onDeleteArchivedEntry,
  onClose,
}) => {
  const [editing, setEditing] = useState(false);
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open || !student) return;
    setEditing(false);
    setLastName(student.lastName);
    setFirstName(student.firstName);
    setNotes(student.notes || '');
  }, [open, student]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !student || !schoolClass) return null;

  const evaluation = evaluateStudent(student, schoolClass);
  const sortedActivities = sortActivitiesChronologically(schoolClass.activities);

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lastName.trim() && !firstName.trim()) return;
    onUpdateStudent(student.id, {
      lastName: lastName.trim(),
      firstName: firstName.trim(),
      notes: notes.trim(),
    });
    setEditing(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="student-history-title"
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <h2
              id="student-history-title"
              className="truncate text-lg font-semibold text-slate-900"
            >
              {student.lastName} {student.firstName}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>Classe {schoolClass.name}</span>
              <span aria-hidden="true">·</span>
              <span>Anno {schoolClass.schoolYear}</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  evaluation.allRequirementsMet
                    ? 'font-semibold text-emerald-700'
                    : 'font-semibold text-amber-700'
                }
              >
                {evaluation.allRequirementsMet
                  ? 'Tutti i requisiti soddisfatti'
                  : `Carenza: ${evaluation.deficitSummary}`}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Edit student details */}
          {editing ? (
            <form
              onSubmit={handleSaveName}
              className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-4"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Cognome
                  </label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    Nome
                  </label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  Annotazioni sullo studente
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Eventuali note didattiche o recuperi programmati..."
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800"
                >
                  Salva nominativo
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
              <div className="text-sm text-slate-600">
                {student.notes ? (
                  <span>Nota: {student.notes}</span>
                ) : (
                  <span className="text-slate-400">Nessuna annotazione sullo studente</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Modifica dati
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenMoveCopy(student.id);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                >
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  Sposta / Copia
                </button>
              </div>
            </div>
          )}

          {/* Category requirement summary */}
          <div>
            <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-slate-500">
              Stato rispetto ai minimi richiesti
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {CATEGORY_ORDER.map((cat) => {
                const ev = evaluation.byCategory[cat];
                const meta = CATEGORY_META[cat];
                return (
                  <div
                    key={cat}
                    className={`rounded-lg border p-3.5 ${
                      ev.met
                        ? 'border-emerald-200 bg-emerald-50/50'
                        : 'border-amber-200 bg-amber-50/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-slate-700">
                        {meta.pluralLabel}
                      </span>
                      {ev.met ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-amber-600" />
                      )}
                    </div>
                    <div className="mt-1.5 flex items-baseline gap-2">
                      <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                        {ev.completedTotal}/{ev.minimum}
                      </span>
                      <span
                        className={`text-xs font-medium ${
                          ev.met ? 'text-emerald-700' : 'text-amber-800'
                        }`}
                      >
                        {ev.met ? 'OK' : `Mancano ${ev.missing}`}
                      </span>
                    </div>
                    {ev.completedArchived > 0 && schoolClass.includeArchivedInCount && (
                      <div className="mt-1 text-[11px] text-slate-500">
                        Include {ev.completedArchived} da storico
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Current class activities */}
          <div>
            <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-slate-500">
              Attività nella classe {schoolClass.name} ({sortedActivities.length})
            </h3>
            {sortedActivities.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nessuna attività ancora inserita in questa classe.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {sortedActivities.map((act) => {
                  const status = getStudentStatus(student, act.id);
                  const statusMeta = STATUS_META[status];
                  const catMeta = CATEGORY_META[act.category];
                  return (
                    <div
                      key={act.id}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-900">
                          {act.title}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                          <span className={catMeta.subtleText}>{catMeta.label}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {formatFullDate(act.date)}
                          </span>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-semibold ${statusMeta.cellBg} ${statusMeta.cellText} ${statusMeta.cellBorder}`}
                      >
                        {statusMeta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Archived history from transfers */}
          <div>
            <div className="mb-2.5 flex items-center gap-2">
              <History className="h-3.5 w-3.5 text-slate-500" />
              <h3 className="text-xs font-semibold tracking-wide text-slate-500">
                Archivio storico da classi precedenti ({student.archivedHistory.length})
              </h3>
            </div>
            {student.archivedHistory.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-4 py-3 text-xs text-slate-500">
                Nessuna prova proveniente da trasferimenti. Quando sposti o copi questo studente in un&apos;altra classe, le sue prove già registrate vengono conservate qui automaticamente.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {student.archivedHistory.map((entry) => {
                  const statusMeta = STATUS_META[entry.status];
                  const catMeta = CATEGORY_META[entry.category];
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-900">
                          {entry.activityTitle}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span>Classe {entry.sourceClassName}</span>
                          <span aria-hidden="true">·</span>
                          <span className={catMeta.subtleText}>{catMeta.label}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {formatFullDate(entry.date)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${statusMeta.cellBg} ${statusMeta.cellText} ${statusMeta.cellBorder}`}
                        >
                          {statusMeta.label}
                        </span>
                        <button
                          type="button"
                          onClick={() => onDeleteArchivedEntry(student.id, entry.id)}
                          className="rounded p-1 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                          title="Rimuovi voce dallo storico"
                          aria-label="Rimuovi voce dallo storico"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-6 py-3.5 rounded-b-xl">
          <button
            type="button"
            onClick={() => onRequestDeleteStudent(student)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 whitespace-nowrap"
          >
            <Trash2 className="h-4 w-4" />
            Elimina studente
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap"
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
};
