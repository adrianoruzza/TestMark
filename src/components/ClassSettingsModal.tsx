import React, { useEffect, useState } from 'react';
import { Minus, Plus, Trash2, X } from 'lucide-react';
import {
  ActivityCategory,
  CATEGORY_META,
  CATEGORY_ORDER,
  CategoryMinimums,
  DEFAULT_MINIMUMS,
  SchoolClass,
} from '../types';

interface ClassSettingsModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  schoolClass: SchoolClass | null;
  existingClassNames: string[];
  onSave: (payload: {
    name: string;
    schoolYear: string;
    minimums: CategoryMinimums;
    includeArchivedInCount: boolean;
  }) => void;
  onRequestDelete?: (schoolClass: SchoolClass) => void;
  onClose: () => void;
}

export const ClassSettingsModal: React.FC<ClassSettingsModalProps> = ({
  open,
  mode,
  schoolClass,
  existingClassNames,
  onSave,
  onRequestDelete,
  onClose,
}) => {
  const [name, setName] = useState('');
  const [schoolYear, setSchoolYear] = useState('2026/2027');
  const [minimums, setMinimums] = useState<CategoryMinimums>({ ...DEFAULT_MINIMUMS });
  const [includeArchivedInCount, setIncludeArchivedInCount] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && schoolClass) {
      setName(schoolClass.name);
      setSchoolYear(schoolClass.schoolYear || '2026/2027');
      setMinimums({ ...schoolClass.minimums });
      setIncludeArchivedInCount(schoolClass.includeArchivedInCount ?? true);
    } else {
      setName('');
      setSchoolYear('2026/2027');
      setMinimums({ ...DEFAULT_MINIMUMS });
      setIncludeArchivedInCount(true);
    }
    setError('');
  }, [open, mode, schoolClass]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const updateMinimum = (cat: ActivityCategory, value: number) => {
    const safeVal = Math.max(0, Math.min(50, Math.floor(value) || 0));
    setMinimums((prev) => ({ ...prev, [cat]: safeVal }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Inserisci il nome della classe (es. 1A, 2B, 4C).');
      return;
    }

    const isDuplicate = existingClassNames.some(
      (n) =>
        n.trim().toLowerCase() === trimmed.toLowerCase() &&
        (mode === 'create' ||
          n.trim().toLowerCase() !== (schoolClass?.name || '').trim().toLowerCase())
    );

    if (isDuplicate) {
      setError(`Esiste già una classe chiamata "${trimmed}". Scegli un altro nome.`);
      return;
    }

    onSave({
      name: trimmed,
      schoolYear: schoolYear.trim() || '2026/2027',
      minimums,
      includeArchivedInCount,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="class-settings-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2
              id="class-settings-title"
              className="text-base font-semibold text-slate-900"
            >
              {mode === 'create'
                ? 'Crea nuova classe'
                : `Impostazioni classe ${schoolClass?.name}`}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Definisci il numero minimo di prove svolte richieste per ciascuna categoria
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
          <div className="space-y-5 px-6 py-5">
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="class-name"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Nome classe *
                </label>
                <input
                  id="class-name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError('');
                  }}
                  placeholder="Es. 2B, 3A, 5D"
                  autoFocus
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div>
                <label
                  htmlFor="class-year"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Anno scolastico
                </label>
                <input
                  id="class-year"
                  type="text"
                  value={schoolYear}
                  onChange={(e) => setSchoolYear(e.target.value)}
                  placeholder="2026/2027"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>
            </div>

            <div className="border-t border-slate-100 pt-4">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  Numero minimo di prove richieste
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Uno studente risulta in regola (verde) solo quando raggiunge il minimo in tutte e tre le categorie.
                </p>
              </div>

              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-slate-50/40">
                {CATEGORY_ORDER.map((cat) => {
                  const meta = CATEGORY_META[cat];
                  const val = minimums[cat];
                  return (
                    <div
                      key={cat}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-sm ${meta.accentBar}`}
                        />
                        <div>
                          <div className="text-sm font-medium text-slate-900">
                            {meta.pluralLabel}
                          </div>
                          <div className="text-xs text-slate-500">
                            Minimo prove svolte valide
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => updateMinimum(cat, val - 1)}
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition-colors hover:bg-slate-100"
                          aria-label={`Riduci minimo ${meta.pluralLabel}`}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <input
                          type="number"
                          min={0}
                          max={50}
                          value={val}
                          onChange={(e) =>
                            updateMinimum(cat, parseInt(e.target.value, 10))
                          }
                          aria-label={`Minimo ${meta.pluralLabel}`}
                          className="h-8 w-14 rounded-md border border-slate-300 bg-white text-center font-mono text-sm font-semibold text-slate-900 tabular-nums focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                        />
                        <button
                          type="button"
                          onClick={() => updateMinimum(cat, val + 1)}
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 transition-colors hover:bg-slate-100"
                          aria-label={`Aumenta minimo ${meta.pluralLabel}`}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3 cursor-pointer">
              <input
                type="checkbox"
                checked={includeArchivedInCount}
                onChange={(e) => setIncludeArchivedInCount(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <div>
                <span className="block text-sm font-medium text-slate-800">
                  Conteggia le prove svolte dallo storico trasferimenti
                </span>
                <span className="block text-xs text-slate-500">
                  Se uno studente è stato spostato o copiato da un&apos;altra classe, le sue prove già svolte contribuiscono ai minimi di questa classe.
                </span>
              </div>
            </label>
          </div>

          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-6 py-3.5 rounded-b-xl">
            <div>
              {mode === 'edit' && schoolClass && onRequestDelete && (
                <button
                  type="button"
                  onClick={() => onRequestDelete(schoolClass)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 whitespace-nowrap"
                >
                  <Trash2 className="h-4 w-4" />
                  Elimina classe
                </button>
              )}
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
              >
                Annulla
              </button>
              <button
                type="submit"
                className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 whitespace-nowrap"
              >
                {mode === 'create' ? 'Crea classe' : 'Salva impostazioni'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
