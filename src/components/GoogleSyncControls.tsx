import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  CloudOff,
  FolderArchive,
  LogOut,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { GoogleDriveSyncController } from '../hooks/useGoogleDriveSync';
import { stripBackupExtension } from '../services/driveBackup';
import {
  BACKUP_SUBFOLDER_NAME,
  SYNC_ROOT_FOLDER_NAME,
} from '../services/googleDrive';
import { DriveBackupItem, DriveBackupPayload, SyncConflict } from '../services/syncTypes';

interface GoogleSignInButtonProps {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}

/**
 * Official-style "Sign in with Google" button (Tailwind-only, zero inline styles).
 */
export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({
  onClick,
  disabled = false,
  label = 'Accedi con Google',
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="inline-flex h-9 items-center justify-center gap-2.5 rounded-md border border-[#dadce0] bg-white px-3.5 text-xs font-medium text-[#1f1f1f] shadow-xs transition-colors hover:bg-[#f8f9fa] active:bg-[#f1f3f4] disabled:cursor-not-allowed disabled:opacity-55 whitespace-nowrap"
  >
    <svg
      version="1.1"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      className="h-4 w-4 shrink-0 block"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
    <span>{label}</span>
  </button>
);

function formatBackupDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours()
  )}.${pad(d.getMinutes())}`;
}

function statusDotClass(
  authStatus: GoogleDriveSyncController['authState']['status'],
  syncStatus: GoogleDriveSyncController['syncState']['status'],
  hasConflicts: boolean
): string {
  if (hasConflicts || syncStatus === 'error') return 'bg-rose-500';
  if (syncStatus === 'offline' || authStatus === 'offline_session') return 'bg-slate-400';
  if (authStatus === 'needs_reauth') return 'bg-amber-500';
  if (syncStatus === 'syncing') return 'bg-blue-600';
  if (syncStatus === 'pending') return 'bg-amber-500';
  if (syncStatus === 'synced' && authStatus === 'authenticated') return 'bg-emerald-600';
  return 'bg-slate-300';
}

interface ConflictListProps {
  conflicts: SyncConflict[];
  onResolve: (conflictId: string, choice: 'local' | 'remote') => void;
}

const ConflictList: React.FC<ConflictListProps> = ({ conflicts, onResolve }) => {
  if (conflicts.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50/70 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-900">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-600" />
        <span>
          Conflitti rilevati ({conflicts.length}) — Entrambe le versioni sono state conservate
        </span>
      </div>
      <div className="space-y-2">
        {conflicts.map((conflict) => (
          <div
            key={conflict.id}
            className="rounded-md border border-rose-200 bg-white p-2.5 text-xs text-slate-800"
          >
            <div className="font-semibold text-slate-900">
              {conflict.className} · {conflict.entityLabel}
            </div>
            <p className="mt-0.5 text-[11px] text-slate-600">{conflict.description}</p>
            <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5">
                <div className="text-[10px] font-semibold uppercase text-slate-500">
                  Versione locale
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-slate-900">
                  {conflict.localSummary}
                </div>
                <button
                  type="button"
                  onClick={() => onResolve(conflict.id, 'local')}
                  className="mt-1.5 inline-flex h-7 items-center rounded bg-slate-900 px-2 text-[11px] font-semibold text-white hover:bg-slate-800"
                >
                  Mantieni locale
                </button>
              </div>
              <div className="rounded border border-blue-200 bg-blue-50/50 px-2 py-1.5">
                <div className="text-[10px] font-semibold uppercase text-blue-700">
                  Versione Google Drive
                </div>
                <div className="mt-0.5 text-[11px] font-medium text-slate-900">
                  {conflict.remoteSummary}
                </div>
                <button
                  type="button"
                  onClick={() => onResolve(conflict.id, 'remote')}
                  className="mt-1.5 inline-flex h-7 items-center rounded bg-blue-700 px-2 text-[11px] font-semibold text-white hover:bg-blue-800"
                >
                  Applica remota
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

interface HeaderSyncIndicatorProps {
  sync: GoogleDriveSyncController;
  onOpenBackupSection: () => void;
}

/**
 * Compact, static (zero blinking/spinning) sync status button in the 44px top bar.
 * Displays the exact required status text and opens a lightweight sync panel on click.
 */
export const HeaderSyncIndicator: React.FC<HeaderSyncIndicatorProps> = ({
  sync,
  onOpenBackupSection,
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const { authState, syncState, syncIndicatorText } = sync;

  const hasConflicts = syncState.conflicts.length > 0;
  const isConnected =
    authState.status === 'authenticated' && authState.hasDriveAccess;

  const compactLabel = (() => {
    if (syncState.status === 'offline') return 'Offline';
    if (authState.status === 'needs_reauth') return 'Riconnetti Drive';
    if (authState.status === 'signed_out' || authState.status === 'initializing') {
      return 'Google Drive';
    }
    if (hasConflicts) {
      return `${syncState.conflicts.length} conflitt${
        syncState.conflicts.length === 1 ? 'o' : 'i'
      }`;
    }
    return syncIndicatorText;
  })();

  const dotColor = statusDotClass(
    authState.status,
    syncState.status,
    hasConflicts
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        title={`Google Drive (${SYNC_ROOT_FOLDER_NAME}): ${syncIndicatorText}`}
        aria-label={`Stato sincronizzazione Google Drive: ${compactLabel}`}
        className="inline-flex h-8 max-w-[230px] items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/75 px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-white hover:text-slate-900 whitespace-nowrap shrink-0"
      >
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`}
          aria-hidden="true"
        />
        {syncState.status === 'offline' ? (
          <CloudOff className="h-3.5 w-3.5 shrink-0 text-slate-500 sm:hidden" />
        ) : (
          <Cloud className="h-3.5 w-3.5 shrink-0 text-slate-500 sm:hidden" />
        )}
        <span className="hidden truncate sm:inline">{compactLabel}</span>
      </button>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="drive-sync-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-blue-700" />
                <h2
                  id="drive-sync-modal-title"
                  className="text-sm font-semibold text-slate-900"
                >
                  Google Drive — {SYNC_ROOT_FOLDER_NAME}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Chiudi"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 px-4 py-3.5 text-xs">
              {/* Status summary */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{syncIndicatorText}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-600 truncate">
                    {authState.user
                      ? authState.user.email
                      : 'Nessun account Google collegato (modalità solo locale)'}
                  </div>
                </div>
                {isConnected && (
                  <button
                    type="button"
                    disabled={syncState.status === 'syncing' || syncState.status === 'offline'}
                    onClick={() => void sync.syncNow()}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-700 px-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Sincronizza ora
                  </button>
                )}
              </div>

              {authState.errorMessage && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                  {authState.errorMessage}
                </div>
              )}

              {syncState.lastError && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
                  {syncState.lastError}
                </div>
              )}

              {/* Auth Actions */}
              {authState.status === 'signed_out' ||
              authState.status === 'error' ||
              authState.status === 'initializing' ||
              (authState.status === 'authenticating' && !authState.user) ? (
                <div className="space-y-2">
                  <p className="text-[11px] leading-relaxed text-slate-600">
                    Accedi con Google per sincronizzare i dati nella cartella{' '}
                    <span className="font-mono font-semibold text-slate-800">
                      {SYNC_ROOT_FOLDER_NAME}
                    </span>{' '}
                    e salvare backup manuali in{' '}
                    <span className="font-mono font-semibold text-slate-800">
                      {SYNC_ROOT_FOLDER_NAME}/{BACKUP_SUBFOLDER_NAME}
                    </span>
                    .
                  </p>
                  <GoogleSignInButton
                    onClick={() => void sync.signIn()}
                    disabled={
                      authState.status === 'authenticating' ||
                      authState.status === 'initializing'
                    }
                    label={
                      authState.status === 'authenticating'
                        ? 'Accesso in corso...'
                        : 'Accedi con Google'
                    }
                  />
                </div>
              ) : authState.status === 'needs_reauth' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <GoogleSignInButton
                    onClick={() => void sync.reconnectDrive()}
                    label="Riconnetti Google Drive"
                  />
                  <button
                    type="button"
                    onClick={() => void sync.signOut()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Disconnetti
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                  <span>
                    Cartella Drive:{' '}
                    <span className="font-mono font-semibold text-slate-800">
                      {SYNC_ROOT_FOLDER_NAME}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void sync.signOut()}
                    className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-rose-700"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Disconnetti account
                  </button>
                </div>
              )}

              {/* Conflicts if any */}
              <ConflictList
                conflicts={syncState.conflicts}
                onResolve={sync.resolveConflict}
              />
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 rounded-b-xl">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  onOpenBackupSection();
                }}
                className="text-xs font-semibold text-blue-700 hover:underline"
              >
                Gestisci backup su Drive →
              </button>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

interface GoogleDriveBackupSectionProps {
  sync: GoogleDriveSyncController;
}

/**
 * Compact Google Drive Sync & Manual Backup management card inside "Classi e Backup".
 */
export const GoogleDriveBackupSection: React.FC<GoogleDriveBackupSectionProps> = ({
  sync,
}) => {
  const { authState, syncState, syncIndicatorText, backups } = sync;
  const isConnected =
    authState.status === 'authenticated' && authState.hasDriveAccess;

  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    item: DriveBackupItem;
    preview: DriveBackupPayload;
  } | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const handleRequestRestore = async (item: DriveBackupItem) => {
    setInspectError(null);
    setInspectingId(item.fileId);
    try {
      const preview = await sync.inspectBackup(item);
      setConfirmTarget({ item, preview });
    } catch (err) {
      setInspectError(
        err instanceof Error
          ? err.message
          : 'Impossibile verificare l’integrità del backup selezionato.'
      );
    } finally {
      setInspectingId(null);
    }
  };

  const handleConfirmRestore = async () => {
    if (!confirmTarget) return;
    const ok = await sync.restoreDriveBackup(confirmTarget.item);
    if (ok) {
      setConfirmTarget(null);
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Cloud className="h-4 w-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-slate-900">
              Google Drive — Sincronizzazione e Backup
            </h2>
            <span className="font-mono text-[11px] text-slate-500">
              {SYNC_ROOT_FOLDER_NAME}/{BACKUP_SUBFOLDER_NAME}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Sincronizzazione local-first tra dispositivi e backup manuali verificati, separati dalla sincronizzazione automatica.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {authState.status === 'signed_out' ||
          authState.status === 'error' ||
          authState.status === 'initializing' ||
          (authState.status === 'authenticating' && !authState.user) ? (
            <GoogleSignInButton
              onClick={() => void sync.signIn()}
              disabled={
                authState.status === 'authenticating' ||
                authState.status === 'initializing'
              }
              label={
                authState.status === 'authenticating'
                  ? 'Accesso in corso...'
                  : 'Accedi con Google'
              }
            />
          ) : authState.status === 'needs_reauth' ? (
            <>
              <GoogleSignInButton
                onClick={() => void sync.reconnectDrive()}
                label="Riconnetti Google Drive"
              />
              <button
                type="button"
                onClick={() => void sync.signOut()}
                className="inline-flex h-9 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                Esci
              </button>
            </>
          ) : (
            <>
              <span className="text-xs font-medium text-slate-700">
                {authState.user?.email}
              </span>
              <button
                type="button"
                disabled={!isConnected || syncState.status === 'syncing'}
                onClick={() => void sync.syncNow()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Sincronizza ora
              </button>
              <button
                type="button"
                onClick={() => void sync.signOut()}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
              >
                <LogOut className="h-3.5 w-3.5" />
                Disconnetti
              </button>
            </>
          )}
        </div>
      </div>

      {/* Status bar & Errors */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-slate-700">
          <span
            className={`h-2 w-2 rounded-full ${statusDotClass(
              authState.status,
              syncState.status,
              syncState.conflicts.length > 0
            )}`}
            aria-hidden="true"
          />
          <span className="font-medium">{syncIndicatorText}</span>
        </div>

        {isConnected && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={sync.creatingBackup}
              onClick={() => void sync.createManualBackup()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-700 px-3 text-xs font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap"
            >
              <FolderArchive className="h-3.5 w-3.5" />
              {sync.creatingBackup
                ? 'Creazione e verifica...'
                : 'Crea backup su Drive'}
            </button>
            <button
              type="button"
              disabled={sync.loadingBackups}
              onClick={() => void sync.refreshBackups()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Aggiorna elenco
            </button>
          </div>
        )}
      </div>

      {authState.errorMessage && (
        <div className="mt-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {authState.errorMessage}
        </div>
      )}

      {(syncState.lastError || sync.backupError || inspectError) && (
        <div className="mt-2.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {inspectError || sync.backupError || syncState.lastError}
        </div>
      )}

      {syncState.conflicts.length > 0 && (
        <div className="mt-3">
          <ConflictList
            conflicts={syncState.conflicts}
            onResolve={sync.resolveConflict}
          />
        </div>
      )}

      {/* Manual Backups Table in SYNC_TestMark/BACKUP */}
      {isConnected && (
        <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full min-w-[520px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                <th className="px-3 py-2">Backup in {SYNC_ROOT_FOLDER_NAME}/{BACKUP_SUBFOLDER_NAME}</th>
                <th className="px-3 py-2">Data e ora</th>
                <th className="px-3 py-2">Contenuto</th>
                <th className="px-3 py-2 text-right">Ripristino</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sync.loadingBackups && backups.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-5 text-center text-slate-500">
                    Caricamento backup da Google Drive...
                  </td>
                </tr>
              ) : backups.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-5 text-center text-slate-500">
                    Nessun backup manuale presente in {SYNC_ROOT_FOLDER_NAME}/{BACKUP_SUBFOLDER_NAME}.
                  </td>
                </tr>
              ) : (
                backups.map((item) => (
                  <tr key={item.fileId} className="hover:bg-slate-50/70">
                    <td className="px-3 py-2 font-mono text-[11px] font-medium text-slate-900">
                      {stripBackupExtension(item.name)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-600 tabular-nums">
                      {formatBackupDate(item.createdTime)}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-600 tabular-nums">
                      {item.classCount !== undefined
                        ? `${item.classCount} classi · ${item.studentCount ?? 0} studenti · ${item.activityCount ?? 0} attività`
                        : 'Backup verificabile'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={
                          inspectingId === item.fileId || sync.restoringBackup
                        }
                        onClick={() => void handleRequestRestore(item)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                      >
                        <RotateCcw className="h-3 w-3" />
                        {inspectingId === item.fileId
                          ? 'Verifica...'
                          : 'Ripristina'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Mandatory Restore Confirmation Dialog */}
      {confirmTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-drive-backup-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-blue-700" />
                <h3
                  id="restore-drive-backup-title"
                  className="text-sm font-semibold text-slate-900"
                >
                  Conferma ripristino backup
                </h3>
              </div>
              <button
                type="button"
                disabled={sync.restoringBackup}
                onClick={() => setConfirmTarget(null)}
                aria-label="Chiudi"
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 px-5 py-4 text-xs text-slate-700">
              <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3">
                <div className="flex items-center gap-1.5 font-semibold text-blue-900">
                  <CheckCircle2 className="h-3.5 w-3.5 text-blue-700 shrink-0" />
                  <span>Integrità backup verificata</span>
                </div>
                <div className="mt-1.5 font-mono text-[11px] font-semibold text-slate-900">
                  {stripBackupExtension(confirmTarget.item.name)}
                </div>
                <div className="mt-1 text-[11px] text-slate-600">
                  {confirmTarget.preview.summary.classCount} classi ·{' '}
                  {confirmTarget.preview.summary.studentCount} studenti ·{' '}
                  {confirmTarget.preview.summary.activityCount} attività
                </div>
              </div>

              <p className="leading-relaxed">
                Prima di applicare il ripristino, TestMark creerà e verificherà
                automaticamente un <strong>backup preventivo dello stato attuale</strong>{' '}
                nella cartella{' '}
                <span className="font-mono font-semibold">
                  {SYNC_ROOT_FOLDER_NAME}/{BACKUP_SUBFOLDER_NAME}
                </span>
                .
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 rounded-b-xl">
              <button
                type="button"
                disabled={sync.restoringBackup}
                onClick={() => setConfirmTarget(null)}
                className="rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Annulla
              </button>
              <button
                type="button"
                disabled={sync.restoringBackup}
                onClick={() => void handleConfirmRestore()}
                className="rounded-md bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {sync.restoringBackup
                  ? 'Backup preventivo e ripristino...'
                  : 'Conferma ripristino'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
