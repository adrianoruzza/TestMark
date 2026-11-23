import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  HardDriveDownload,
  HardDriveUpload,
  Settings2,
  Trash2,
} from 'lucide-react';
import { GoogleDriveSyncController } from '../hooks/useGoogleDriveSync';
import { AppDatabase, SchoolClass } from '../types';
import { evaluateStudent } from '../utils/calculations';
import { exportAllClassesToExcel, exportClassToExcel } from '../utils/excelExport';
import { exportDatabaseBackupJson, parseBackupFile } from '../utils/storage';
import { GoogleDriveBackupSection } from './GoogleSyncControls';

interface ArchiveSettingsViewProps {
  db: AppDatabase;
  driveSync: GoogleDriveSyncController;
  onEditClass: (cls: SchoolClass) => void;
  onRequestDeleteClass: (cls: SchoolClass) => void;
  onOpenClass: (classId: string) => void;
  onRestoreBackup: (backup: AppDatabase, mode: 'replace' | 'merge') => void;
}

export const ArchiveSettingsView: React.FC<ArchiveSettingsViewProps> = ({
  db,
  driveSync,
  onEditClass,
  onRequestDeleteClass,
  onOpenClass,
  onRestoreBackup,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingBackup, setPendingBackup] = useState<AppDatabase | null>(null);
  const [backupFileName, setBackupFileName] = useState('');
  const [backupError, setBackupError] = useState('');

  const handleSelectBackupFile = async (file: File) => {
    setBackupError('');
    try {
      const parsed = await parseBackupFile(file);
      setPendingBackup(parsed);
      setBackupFileName(file.name);
    } catch (err) {
      setPendingBackup(null);
      setBackupError(
        err instanceof Error ? err.message : 'Errore durante la lettura del backup.'
      );
    }
  };

  const formattedLastSaved = (() => {
    try {
      return new Date(db.updatedAt).toLocaleString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '—';
    }
  })();

  const totalStudents = db.classes.reduce((sum, c) => sum + c.students.length, 0);
  const totalActivities = db.classes.reduce((sum, c) => sum + c.activities.length, 0);

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-3 px-2.5 py-2.5 sm:px-4 sm:py-3">
      {/* Classes Archive Table */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <h2 className="text-sm font-semibold text-slate-900">
              Archivio classi ({db.classes.length})
            </h2>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span className="font-mono text-slate-600 tabular-nums">
              {totalStudents} studenti · {totalActivities} attività
            </span>
          </div>
          <span className="text-[11px] text-slate-500">
            Ultimo salvataggio:{' '}
            <span className="font-mono text-slate-700 tabular-nums">
              {formattedLastSaved}
            </span>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-3.5 py-2">Classe</th>
                <th className="px-3 py-2">Anno</th>
                <th className="px-3 py-2 text-right">Studenti</th>
                <th className="px-3 py-2 text-right">Attività</th>
                <th className="px-3 py-2">Minimi (G/O/P)</th>
                <th className="px-3 py-2">In regola</th>
                <th className="px-3.5 py-2 text-right">Azioni</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {db.classes.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-slate-500"
                  >
                    Nessuna classe creata. Usa &quot;+ Classe&quot; nella barra superiore.
                  </td>
                </tr>
              ) : (
                db.classes.map((cls) => {
                  const okCount = cls.students.filter(
                    (s) => evaluateStudent(s, cls).allRequirementsMet
                  ).length;
                  return (
                    <tr key={cls.id} className="hover:bg-slate-50/70">
                      <td className="px-3.5 py-2">
                        <button
                          type="button"
                          onClick={() => onOpenClass(cls.id)}
                          className="font-semibold text-blue-700 hover:underline"
                        >
                          Classe {cls.name}
                        </button>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600 tabular-nums">
                        {cls.schoolYear}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-slate-800 tabular-nums">
                        {cls.students.length}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-slate-800 tabular-nums">
                        {cls.activities.length}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-700 tabular-nums">
                        {cls.minimums.COMPITO_GRAFICO}/{cls.minimums.INTERROGAZIONE_ORALE}/
                        {cls.minimums.CONSEGNA_PRATICO}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs tabular-nums">
                        <span
                          className={
                            cls.students.length > 0 && okCount === cls.students.length
                              ? 'font-semibold text-emerald-700'
                              : 'text-slate-700'
                          }
                        >
                          {okCount}/{cls.students.length}
                        </span>
                      </td>
                      <td className="px-3.5 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onEditClass(cls)}
                            title="Impostazioni e minimi"
                            aria-label={`Impostazioni classe ${cls.name}`}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                            <span className="hidden md:inline">Minimi</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => exportClassToExcel(cls)}
                            title={`Esporta classe ${cls.name} in Excel`}
                            aria-label={`Esporta classe ${cls.name} in Excel`}
                            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                          >
                            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-700" />
                            <span className="hidden md:inline">Excel</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onRequestDeleteClass(cls)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-rose-700 hover:bg-rose-50"
                            title={`Elimina classe ${cls.name}`}
                            aria-label={`Elimina classe ${cls.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Google Drive Sync & Verified Manual Backups */}
      <GoogleDriveBackupSection sync={driveSync} />

      {/* Compact Export & Backup Two-Column Grid */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Excel Export */}
        <section className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-4">
          <div>
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-emerald-700" />
              <h2 className="text-sm font-semibold text-slate-900">
                Esportazione Excel completa (.xlsx)
              </h2>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              File multi-foglio con <strong>Resoconto Generale</strong> e una scheda per ciascuna classe, con conteggi per categoria e carenze.
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              disabled={db.classes.length === 0}
              onClick={() => exportAllClassesToExcel(db.classes)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-700 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              Esporta tutte le classi (.xlsx)
            </button>
          </div>
        </section>

        {/* Full JSON Backup & Restore */}
        <section className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white p-4">
          <div>
            <div className="flex items-center gap-2">
              <HardDriveDownload className="h-4 w-4 text-blue-700" />
              <h2 className="text-sm font-semibold text-slate-900">
                Backup e ripristino archivio (.json)
              </h2>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Copia integrale di classi, studenti, attività, minimi e storico trasferimenti, ripristinabile su qualsiasi browser.
            </p>

            {backupError && (
              <div className="mt-2.5 flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                <span>{backupError}</span>
              </div>
            )}

            {pendingBackup && (
              <div className="mt-3 space-y-2 rounded-md border border-blue-200 bg-blue-50/60 p-3 text-xs text-slate-800">
                <div className="flex items-center gap-1.5 font-semibold text-blue-900">
                  <CheckCircle2 className="h-3.5 w-3.5 text-blue-700" />
                  Backup: {backupFileName} ({pendingBackup.classes.length} classi)
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      onRestoreBackup(pendingBackup, 'replace');
                      setPendingBackup(null);
                    }}
                    className="rounded-md bg-blue-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap"
                  >
                    Sostituisci archivio
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onRestoreBackup(pendingBackup, 'merge');
                      setPendingBackup(null);
                    }}
                    className="rounded-md border border-blue-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-800 hover:bg-blue-50 whitespace-nowrap"
                  >
                    Aggiungi classi
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingBackup(null)}
                    className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200/60"
                  >
                    Annulla
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => exportDatabaseBackupJson(db)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap"
            >
              <HardDriveDownload className="h-3.5 w-3.5" />
              Scarica backup (.json)
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleSelectBackupFile(file);
                e.target.value = '';
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
            >
              <HardDriveUpload className="h-3.5 w-3.5" />
              Ripristina
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
