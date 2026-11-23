import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Copy, History, Info, X } from 'lucide-react';
import { SchoolClass } from '../types';
import {
  buildArchivedEntriesFromClass,
  normalizeNameKey,
  sortStudentsAlphabetically,
} from '../utils/calculations';

interface MoveCopyStudentModalProps {
  open: boolean;
  sourceClass: SchoolClass | null;
  allClasses: SchoolClass[];
  initialStudentId?: string | null;
  onConfirm: (payload: {
    studentId: string;
    targetClassId: string;
    operation: 'move' | 'copy';
  }) => void;
  onClose: () => void;
}

export const MoveCopyStudentModal: React.FC<MoveCopyStudentModalProps> = ({
  open,
  sourceClass,
  allClasses,
  initialStudentId,
  onConfirm,
  onClose,
}) => {
  const [studentId, setStudentId] = useState('');
  const [targetClassId, setTargetClassId] = useState('');
  const [operation, setOperation] = useState<'move' | 'copy'>('move');

  const destinationClasses = useMemo(
    () => allClasses.filter((c) => c.id !== sourceClass?.id),
    [allClasses, sourceClass]
  );

  const sortedStudents = useMemo(
    () => (sourceClass ? sortStudentsAlphabetically(sourceClass.students) : []),
    [sourceClass]
  );

  useEffect(() => {
    if (!open || !sourceClass) return;
    const defaultStudent =
      (initialStudentId &&
        sourceClass.students.find((s) => s.id === initialStudentId)?.id) ||
      sortedStudents[0]?.id ||
      '';
    setStudentId(defaultStudent);
    setTargetClassId(destinationClasses[0]?.id || '');
    setOperation('move');
  }, [open, sourceClass, initialStudentId, sortedStudents, destinationClasses]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !sourceClass) return null;

  const selectedStudent = sourceClass.students.find((s) => s.id === studentId) || null;
  const targetClass = destinationClasses.find((c) => c.id === targetClassId) || null;

  const archivedPreviewCount = selectedStudent
    ? buildArchivedEntriesFromClass(selectedStudent, sourceClass).length
    : 0;
  const currentSvoltiCount = selectedStudent
    ? Object.values(selectedStudent.records).filter((s) => s === 'SVOLTO').length
    : 0;

  const duplicateInTarget = Boolean(
    selectedStudent &&
      targetClass &&
      targetClass.students.some(
        (s) =>
          normalizeNameKey(s.lastName, s.firstName) ===
          normalizeNameKey(selectedStudent.lastName, selectedStudent.firstName)
      )
  );

  const canSubmit = Boolean(selectedStudent && targetClass);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm({
      studentId,
      targetClassId,
      operation,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-copy-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2
              id="move-copy-title"
              className="text-base font-semibold text-slate-900"
            >
              Sposta o copia studente
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Classe di origine: {sourceClass.name} · Lo storico delle prove viene conservato
            </p>
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

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 px-6 py-5">
            {destinationClasses.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Non esistono ancora altre classi di destinazione. Crea prima una nuova classe per poter spostare o copiare uno studente.
              </div>
            ) : sortedStudents.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                Nessuno studente presente nella classe {sourceClass.name}.
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="transfer-student"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Studente da trasferire
                  </label>
                  <select
                    id="transfer-student"
                    value={studentId}
                    onChange={(e) => setStudentId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                  >
                    {sortedStudents.map((stu) => (
                      <option key={stu.id} value={stu.id}>
                        {stu.lastName} {stu.firstName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="transfer-target-class"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Classe di destinazione
                  </label>
                  <select
                    id="transfer-target-class"
                    value={targetClassId}
                    onChange={(e) => setTargetClassId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                  >
                    {destinationClasses.map((cls) => (
                      <option key={cls.id} value={cls.id}>
                        Classe {cls.name} ({cls.students.length} studenti)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">
                    Modalità di operazione
                  </span>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setOperation('move')}
                      className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        operation === 'move'
                          ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          Sposta studente
                        </div>
                        <div className="mt-0.5 text-xs text-slate-600">
                          Trasferisce nella classe {targetClass?.name} e rimuove da {sourceClass.name}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setOperation('copy')}
                      className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        operation === 'copy'
                          ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <Copy className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          Copia studente
                        </div>
                        <div className="mt-0.5 text-xs text-slate-600">
                          Aggiunge in {targetClass?.name} mantenendo anche l&apos;originale in {sourceClass.name}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {selectedStudent && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-700 space-y-1.5">
                    <div className="flex items-center gap-2 font-medium text-slate-900">
                      <History className="h-3.5 w-3.5 text-slate-600" />
                      Conservazione dello storico
                    </div>
                    <p className="leading-relaxed">
                      Tutte le prove registrate in <strong>{sourceClass.name}</strong> ({currentSvoltiCount}{' '}
                      svolte) verranno archiviate in modo sicuro nello storico personale di{' '}
                      <strong>
                        {selectedStudent.lastName} {selectedStudent.firstName}
                      </strong>{' '}
                      (totale {archivedPreviewCount} registrazioni storiche conservate).
                    </p>
                  </div>
                )}

                {duplicateInTarget && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <span>
                      Attenzione: nella classe <strong>{targetClass?.name}</strong> è già presente uno studente con lo stesso nominativo. Puoi comunque procedere se si tratta di un omonimo o di un inserimento intenzionale.
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2.5 border-t border-slate-200 bg-slate-50/70 px-6 py-3.5 rounded-b-xl">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              {operation === 'move' ? 'Sposta studente' : 'Copia studente'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
