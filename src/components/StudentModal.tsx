import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Trash2,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { SchoolClass } from '../types';
import { normalizeNameKey } from '../utils/calculations';
import {
  ExtractionConfig,
  PreviewStudentRow,
  RawImportPayload,
  buildPreviewRows,
  detectDefaultExtractionConfig,
  parseStudentImportFile,
  recomputePreviewDuplicates,
} from '../utils/studentImport';

interface StudentModalProps {
  open: boolean;
  initialTab?: 'manual' | 'import';
  schoolClass: SchoolClass | null;
  onAddStudents: (students: { lastName: string; firstName: string; notes?: string }[]) => void;
  onClose: () => void;
}

export const StudentModal: React.FC<StudentModalProps> = ({
  open,
  initialTab = 'manual',
  schoolClass,
  onAddStudents,
  onClose,
}) => {
  const [tab, setTab] = useState<'manual' | 'import'>(initialTab);

  // Manual entry state
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [notes, setNotes] = useState('');
  const [manualError, setManualError] = useState('');
  const [addedCountInSession, setAddedCountInSession] = useState(0);
  const lastNameInputRef = useRef<HTMLInputElement>(null);

  // File import state
  const [rawPayload, setRawPayload] = useState<RawImportPayload | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [config, setConfig] = useState<ExtractionConfig>({
    mode: 'single_column',
    fullNameCol: 0,
    lastNameCol: 0,
    firstNameCol: 1,
    hasHeaderRow: false,
    nameOrder: 'cognome_nome',
  });
  const [previewRows, setPreviewRows] = useState<PreviewStudentRow[]>([]);
  const [importError, setImportError] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setLastName('');
    setFirstName('');
    setNotes('');
    setManualError('');
    setAddedCountInSession(0);
    setRawPayload(null);
    setSheetIndex(0);
    setPreviewRows([]);
    setImportError('');
    setIsParsing(false);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const activeSheet = rawPayload?.sheets[sheetIndex] ?? null;

  const columnOptions = useMemo(() => {
    if (!activeSheet) return [];
    const maxCols = activeSheet.rows.reduce((m, r) => Math.max(m, r.length), 1);
    const firstRow = activeSheet.rows[0] || [];
    const secondRow = activeSheet.rows[1] || [];
    return Array.from({ length: maxCols }, (_, idx) => {
      const colLetter = String.fromCharCode(65 + (idx % 26));
      const sample = (config.hasHeaderRow ? firstRow[idx] : firstRow[idx] || secondRow[idx]) || '';
      const trimmedSample = sample.length > 26 ? `${sample.slice(0, 26)}…` : sample;
      return {
        index: idx,
        label: trimmedSample ? `Colonna ${colLetter} — ${trimmedSample}` : `Colonna ${colLetter}`,
      };
    });
  }, [activeSheet, config.hasHeaderRow]);

  const rebuildPreview = (
    rows: string[][],
    nextConfig: ExtractionConfig
  ) => {
    if (!schoolClass) return;
    const built = buildPreviewRows(rows, nextConfig, schoolClass.students);
    setPreviewRows(built);
  };

  const handleFileSelected = async (file: File) => {
    if (!schoolClass) return;
    setIsParsing(true);
    setImportError('');
    try {
      const payload = await parseStudentImportFile(file);
      const firstSheet = payload.sheets[0];
      const detected = detectDefaultExtractionConfig(firstSheet.rows);
      setRawPayload(payload);
      setSheetIndex(0);
      setConfig(detected);
      setPreviewRows(buildPreviewRows(firstSheet.rows, detected, schoolClass.students));
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Errore durante la lettura del file.'
      );
      setRawPayload(null);
      setPreviewRows([]);
    } finally {
      setIsParsing(false);
    }
  };

  const handleSheetChange = (nextIndex: number) => {
    if (!rawPayload) return;
    setSheetIndex(nextIndex);
    const sheet = rawPayload.sheets[nextIndex];
    if (!sheet) return;
    const detected = detectDefaultExtractionConfig(sheet.rows);
    setConfig(detected);
    rebuildPreview(sheet.rows, detected);
  };

  const handleConfigChange = (patch: Partial<ExtractionConfig>) => {
    if (!activeSheet) return;
    const nextConfig = { ...config, ...patch };
    setConfig(nextConfig);
    rebuildPreview(activeSheet.rows, nextConfig);
  };

  const handleUpdatePreviewRow = (
    rowId: string,
    patch: Partial<Pick<PreviewStudentRow, 'lastName' | 'firstName' | 'selected'>>
  ) => {
    if (!schoolClass) return;
    setPreviewRows((prev) => {
      const updated = prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r));
      if ('lastName' in patch || 'firstName' in patch) {
        return recomputePreviewDuplicates(updated, schoolClass.students);
      }
      return updated;
    });
  };

  const handleSwapRow = (rowId: string) => {
    if (!schoolClass) return;
    setPreviewRows((prev) => {
      const updated = prev.map((r) =>
        r.rowId === rowId ? { ...r, lastName: r.firstName, firstName: r.lastName } : r
      );
      return recomputePreviewDuplicates(updated, schoolClass.students);
    });
  };

  const handleSwapAllRows = () => {
    if (!schoolClass) return;
    setPreviewRows((prev) => {
      const updated = prev.map((r) => ({
        ...r,
        lastName: r.firstName,
        firstName: r.lastName,
      }));
      return recomputePreviewDuplicates(updated, schoolClass.students);
    });
  };

  const handleRemovePreviewRow = (rowId: string) => {
    if (!schoolClass) return;
    setPreviewRows((prev) =>
      recomputePreviewDuplicates(
        prev.filter((r) => r.rowId !== rowId),
        schoolClass.students
      )
    );
  };

  const handleManualSubmit = (keepOpen: boolean) => {
    if (!schoolClass) return;
    const cleanLast = lastName.trim();
    const cleanFirst = firstName.trim();
    if (!cleanLast && !cleanFirst) {
      setManualError('Inserisci almeno il cognome o il nome dello studente.');
      return;
    }

    const key = normalizeNameKey(cleanLast, cleanFirst);
    const exists = schoolClass.students.some(
      (s) => normalizeNameKey(s.lastName, s.firstName) === key
    );
    if (exists) {
      setManualError(
        `"${cleanLast} ${cleanFirst}" è già presente nella classe ${schoolClass.name}.`
      );
      return;
    }

    onAddStudents([
      {
        lastName: cleanLast,
        firstName: cleanFirst,
        notes: notes.trim() || undefined,
      },
    ]);

    if (keepOpen) {
      setLastName('');
      setFirstName('');
      setNotes('');
      setManualError('');
      setAddedCountInSession((c) => c + 1);
      setTimeout(() => lastNameInputRef.current?.focus(), 0);
    } else {
      onClose();
    }
  };

  const selectedImportRows = useMemo(
    () =>
      previewRows.filter(
        (r) => r.selected && (r.lastName.trim() !== '' || r.firstName.trim() !== '')
      ),
    [previewRows]
  );

  const duplicateCount = useMemo(
    () => previewRows.filter((r) => r.duplicateReason !== null).length,
    [previewRows]
  );

  const handleConfirmImport = () => {
    if (selectedImportRows.length === 0) return;
    onAddStudents(
      selectedImportRows.map((r) => ({
        lastName: r.lastName.trim(),
        firstName: r.firstName.trim(),
      }))
    );
    onClose();
  };

  if (!open || !schoolClass) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="student-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2
              id="student-modal-title"
              className="text-base font-semibold text-slate-900"
            >
              Aggiungi studenti — Classe {schoolClass.name}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Inserisci manualmente un singolo studente oppure importa un elenco da Excel, Word o file di testo
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

        {/* Mode Tabs */}
        <div className="border-b border-slate-200 bg-slate-50/70 px-6 py-2.5">
          <div className="inline-flex rounded-lg bg-slate-200/70 p-1">
            <button
              type="button"
              onClick={() => setTab('manual')}
              className={`inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                tab === 'manual'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <UserPlus className="h-3.5 w-3.5" />
              Inserimento manuale
            </button>
            <button
              type="button"
              onClick={() => setTab('import')}
              className={`inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                tab === 'import'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              Importa da file (.xlsx, .docx, .txt)
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'manual' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleManualSubmit(false);
              }}
              className="space-y-4"
            >
              {addedCountInSession > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>
                    {addedCountInSession === 1
                      ? '1 studente aggiunto alla classe.'
                      : `${addedCountInSession} studenti aggiunti alla classe.`}{' '}
                    Puoi inserirne un altro qui sotto.
                  </span>
                </div>
              )}

              {manualError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                  <span>{manualError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="student-lastname"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Cognome *
                  </label>
                  <input
                    ref={lastNameInputRef}
                    id="student-lastname"
                    type="text"
                    value={lastName}
                    onChange={(e) => {
                      setLastName(e.target.value);
                      setManualError('');
                    }}
                    placeholder="Es. Rossi"
                    autoFocus
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                  />
                </div>
                <div>
                  <label
                    htmlFor="student-firstname"
                    className="mb-1.5 block text-sm font-medium text-slate-700"
                  >
                    Nome *
                  </label>
                  <input
                    id="student-firstname"
                    type="text"
                    value={firstName}
                    onChange={(e) => {
                      setFirstName(e.target.value);
                      setManualError('');
                    }}
                    placeholder="Es. Mario"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="student-notes"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Annotazioni (facoltativo)
                </label>
                <input
                  id="student-notes"
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Eventuali note utili per il docente..."
                  className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                >
                  Chiudi
                </button>
                <button
                  type="button"
                  onClick={() => handleManualSubmit(true)}
                  className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-800 transition-colors hover:bg-blue-100 whitespace-nowrap"
                >
                  Salva e aggiungi un altro
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 whitespace-nowrap"
                >
                  Salva studente
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-5">
              {/* Dropzone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleFileSelected(file);
                }}
                className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
                  isDragOver
                    ? 'border-blue-500 bg-blue-50/60'
                    : 'border-slate-300 bg-slate-50/60 hover:border-slate-400'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.docx,.txt,.csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelected(file);
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <div className="flex flex-col items-center justify-center gap-2">
                  <div className="flex items-center gap-2 text-slate-500">
                    <FileSpreadsheet className="h-5 w-5" />
                    <FileText className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-medium text-slate-900">
                    {isParsing
                      ? 'Lettura del file in corso...'
                      : rawPayload
                        ? `File caricato: ${rawPayload.fileName}`
                        : 'Trascina qui un file elenco studenti oppure selezionalo dal computer'}
                  </div>
                  <p className="text-xs text-slate-500">
                    Formati supportati: Excel (.xlsx), Word (.docx), Testo (.txt)
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1 rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                  >
                    {rawPayload ? 'Scegli un altro file' : 'Seleziona file'}
                  </button>
                </div>
              </div>

              {importError && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
                  <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                  <span>{importError}</span>
                </div>
              )}

              {/* Column & parsing configuration */}
              {rawPayload && activeSheet && (
                <>
                  <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold tracking-wide text-slate-700">
                        Configurazione colonne e riconoscimento nominativi
                      </h3>
                      <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={config.hasHeaderRow}
                          onChange={(e) =>
                            handleConfigChange({ hasHeaderRow: e.target.checked })
                          }
                          className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700"
                        />
                        La prima riga contiene intestazioni
                      </label>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {rawPayload.sheets.length > 1 && (
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-600">
                            Foglio Excel
                          </label>
                          <select
                            value={sheetIndex}
                            onChange={(e) => handleSheetChange(Number(e.target.value))}
                            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                          >
                            {rawPayload.sheets.map((sh, i) => (
                              <option key={sh.name} value={i}>
                                {sh.name} ({sh.rows.length} righe)
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-600">
                          Struttura elenco
                        </label>
                        <select
                          value={config.mode}
                          onChange={(e) =>
                            handleConfigChange({
                              mode: e.target.value as 'single_column' | 'two_columns',
                            })
                          }
                          className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                        >
                          <option value="single_column">
                            Colonna singola (Cognome e Nome)
                          </option>
                          {columnOptions.length >= 2 && (
                            <option value="two_columns">
                              Due colonne separate (Cognome / Nome)
                            </option>
                          )}
                        </select>
                      </div>

                      {config.mode === 'single_column' ? (
                        <>
                          {columnOptions.length > 1 && (
                            <div>
                              <label className="mb-1 block text-xs font-medium text-slate-600">
                                Colonna nominativi
                              </label>
                              <select
                                value={config.fullNameCol}
                                onChange={(e) =>
                                  handleConfigChange({
                                    fullNameCol: Number(e.target.value),
                                  })
                                }
                                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                              >
                                {columnOptions.map((col) => (
                                  <option key={col.index} value={col.index}>
                                    {col.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">
                              Ordine nel file
                            </label>
                            <select
                              value={config.nameOrder}
                              onChange={(e) =>
                                handleConfigChange({
                                  nameOrder: e.target.value as
                                    | 'cognome_nome'
                                    | 'nome_cognome',
                                })
                              }
                              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                            >
                              <option value="cognome_nome">Cognome Nome</option>
                              <option value="nome_cognome">Nome Cognome</option>
                            </select>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">
                              Colonna Cognome
                            </label>
                            <select
                              value={config.lastNameCol}
                              onChange={(e) =>
                                handleConfigChange({
                                  lastNameCol: Number(e.target.value),
                                })
                              }
                              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                            >
                              {columnOptions.map((col) => (
                                <option key={col.index} value={col.index}>
                                  {col.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="mb-1 block text-xs font-medium text-slate-600">
                              Colonna Nome
                            </label>
                            <select
                              value={config.firstNameCol}
                              onChange={(e) =>
                                handleConfigChange({
                                  firstNameCol: Number(e.target.value),
                                })
                              }
                              className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                            >
                              {columnOptions.map((col) => (
                                <option key={col.index} value={col.index}>
                                  {col.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Preview Table */}
                  <div>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs text-slate-600">
                        <span className="font-semibold text-slate-900">
                          Anteprima importazione
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {selectedImportRows.length} selezionati su {previewRows.length}
                        </span>
                        {duplicateCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-medium text-amber-700">
                              {duplicateCount} duplicati esclusi automaticamente
                            </span>
                          </>
                        )}
                      </div>

                      {previewRows.length > 0 && (
                        <button
                          type="button"
                          onClick={handleSwapAllRows}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                        >
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                          Inverti Cognome / Nome per tutti
                        </button>
                      )}
                    </div>

                    {previewRows.length === 0 ? (
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                        Nessun nominativo rilevato con le impostazioni correnti. Prova a selezionare una colonna diversa.
                      </div>
                    ) : (
                      <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
                        <table className="w-full border-collapse text-left text-xs">
                          <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
                            <tr className="border-b border-slate-200">
                              <th className="w-9 px-3 py-2 text-center">
                                <input
                                  type="checkbox"
                                  aria-label="Seleziona tutti"
                                  checked={
                                    previewRows.length > 0 &&
                                    previewRows.every((r) => r.selected)
                                  }
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setPreviewRows((prev) =>
                                      prev.map((r) => ({ ...r, selected: checked }))
                                    );
                                  }}
                                  className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700"
                                />
                              </th>
                              <th className="px-2 py-2 font-semibold">Cognome</th>
                              <th className="px-2 py-2 font-semibold">Nome</th>
                              <th className="px-2 py-2 font-semibold">Stato</th>
                              <th className="w-16 px-2 py-2 text-right font-semibold">
                                Azioni
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {previewRows.map((row) => (
                              <tr
                                key={row.rowId}
                                className={
                                  row.duplicateReason
                                    ? 'bg-amber-50/40'
                                    : row.selected
                                      ? 'bg-white'
                                      : 'bg-slate-50/60 opacity-70'
                                }
                              >
                                <td className="px-3 py-1.5 text-center">
                                  <input
                                    type="checkbox"
                                    checked={row.selected}
                                    onChange={(e) =>
                                      handleUpdatePreviewRow(row.rowId, {
                                        selected: e.target.checked,
                                      })
                                    }
                                    className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700"
                                  />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input
                                    type="text"
                                    value={row.lastName}
                                    onChange={(e) =>
                                      handleUpdatePreviewRow(row.rowId, {
                                        lastName: e.target.value,
                                      })
                                    }
                                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                                  />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input
                                    type="text"
                                    value={row.firstName}
                                    onChange={(e) =>
                                      handleUpdatePreviewRow(row.rowId, {
                                        firstName: e.target.value,
                                      })
                                    }
                                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
                                  />
                                </td>
                                <td className="px-2 py-1.5 whitespace-nowrap">
                                  {row.duplicateReason === 'existing' ? (
                                    <span className="font-medium text-amber-800">
                                      Già in classe
                                    </span>
                                  ) : row.duplicateReason === 'in_file' ? (
                                    <span className="font-medium text-amber-800">
                                      Duplicato nel file
                                    </span>
                                  ) : (
                                    <span className="text-emerald-700">Nuovo</span>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => handleSwapRow(row.rowId)}
                                    title="Inverti Cognome e Nome"
                                    className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                                  >
                                    <ArrowLeftRight className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRemovePreviewRow(row.rowId)}
                                    title="Rimuovi riga"
                                    className="rounded p-1 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer for Import tab */}
        {tab === 'import' && (
          <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-6 py-3.5 rounded-b-xl">
            <span className="text-xs text-slate-500">
              Puoi correggere qualsiasi nominativo direttamente nell&apos;anteprima prima di confermare.
            </span>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
              >
                Annulla
              </button>
              <button
                type="button"
                disabled={selectedImportRows.length === 0}
                onClick={handleConfirmImport}
                className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
              >
                Importa {selectedImportRows.length}{' '}
                {selectedImportRows.length === 1 ? 'studente' : 'studenti'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
