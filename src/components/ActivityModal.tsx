import React, { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import {
  Activity,
  ActivityCategory,
  CATEGORY_META,
  CATEGORY_ORDER,
} from '../types';

interface ActivityModalProps {
  open: boolean;
  classNameLabel: string;
  editingActivity: Activity | null;
  onSave: (payload: {
    title: string;
    category: ActivityCategory;
    date: string;
    notes: string;
  }) => void;
  onRequestDelete?: (activity: Activity) => void;
  onClose: () => void;
}

export const ActivityModal: React.FC<ActivityModalProps> = ({
  open,
  classNameLabel,
  editingActivity,
  onSave,
  onRequestDelete,
  onClose,
}) => {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ActivityCategory>('COMPITO_GRAFICO');
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editingActivity) {
      setTitle(editingActivity.title);
      setCategory(editingActivity.category);
      setDate(editingActivity.date);
      setNotes(editingActivity.notes || '');
    } else {
      setTitle('');
      setCategory('COMPITO_GRAFICO');
      setDate(new Date().toISOString().slice(0, 10));
      setNotes('');
    }
    setError('');
  }, [open, editingActivity]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Inserisci il titolo della prova o attività.');
      return;
    }
    if (!date) {
      setError('Seleziona la data di svolgimento.');
      return;
    }
    onSave({
      title: trimmedTitle,
      category,
      date,
      notes: notes.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="activity-modal-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2
              id="activity-modal-title"
              className="text-base font-semibold text-slate-900"
            >
              {editingActivity ? 'Modifica attività' : 'Nuova attività'}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Classe {classNameLabel} · Le attività vengono ordinate cronologicamente
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
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="activity-title"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Titolo della prova *
              </label>
              <input
                id="activity-title"
                type="text"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setError('');
                }}
                placeholder="Es. Tavola 4 — Proiezione piramide"
                autoFocus
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
            </div>

            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                Categoria *
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {CATEGORY_ORDER.map((cat) => {
                  const meta = CATEGORY_META[cat];
                  const active = category === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(cat)}
                      className={`flex flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        active
                          ? 'border-blue-600 bg-blue-50/70 text-slate-900 ring-1 ring-blue-600'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`mb-1.5 h-1.5 w-8 rounded-full ${meta.accentBar}`}
                      />
                      <span className="text-xs font-semibold leading-tight">
                        {meta.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label
                htmlFor="activity-date"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Data di svolgimento *
              </label>
              <input
                id="activity-date"
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setError('');
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
            </div>

            <div>
              <label
                htmlFor="activity-notes"
                className="mb-1.5 block text-sm font-medium text-slate-700"
              >
                Annotazioni (facoltativo)
              </label>
              <textarea
                id="activity-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Materiali richiesti, consegna prevista o note operative..."
                className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-6 py-3.5 rounded-b-xl">
            <div>
              {editingActivity && onRequestDelete && (
                <button
                  type="button"
                  onClick={() => onRequestDelete(editingActivity)}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 whitespace-nowrap"
                >
                  <Trash2 className="h-4 w-4" />
                  Elimina attività
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
                {editingActivity ? 'Salva modifiche' : 'Aggiungi attività'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
