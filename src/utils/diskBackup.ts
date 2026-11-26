import { AppDatabase } from '../types';
import {
  FileSystemDirectoryHandleLike,
  PersistedUiState,
  clearBackupDirectoryHandle,
  readBackupDirectoryHandle,
  writeBackupDirectoryHandle,
} from './indexedDbStorage';

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }) => Promise<FileSystemDirectoryHandleLike>;
}

export type DiskBackupResult =
  | {
      status: 'saved_to_folder';
      folderName: string;
      fileName: string;
      timestamp: string;
    }
  | {
      status: 'downloaded_fallback';
      fileName: string;
      timestamp: string;
      reason: 'unsupported_browser' | 'iframe_restricted';
    }
  | {
      status: 'cancelled';
    }
  | {
      status: 'permission_or_folder_error';
      folderName?: string;
      message: string;
    }
  | {
      status: 'error';
      message: string;
    };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildBackupFilename(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = pad2(now.getMonth() + 1);
  const day = pad2(now.getDate());
  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  return `TestMark_Backup_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.json`;
}

export function formatBackupDateTime(now: Date = new Date()): string {
  const day = pad2(now.getDate());
  const month = pad2(now.getMonth() + 1);
  const year = now.getFullYear();
  const hours = pad2(now.getHours());
  const minutes = pad2(now.getMinutes());
  const seconds = pad2(now.getSeconds());
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

export function buildFullBackupJson(
  db: AppDatabase,
  uiState: PersistedUiState,
  now: Date = new Date()
): string {
  return JSON.stringify(
    {
      ...db,
      uiState,
      exportedAt: now.toISOString(),
      application: 'TestMark',
    },
    null,
    2
  );
}

export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
  );
}

function triggerClassicDownload(jsonContent: string, fileName: string): void {
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function ensureReadWritePermission(
  handle: FileSystemDirectoryHandleLike
): Promise<boolean> {
  const options = { mode: 'readwrite' as const };
  if (typeof handle.queryPermission === 'function') {
    const current = await handle.queryPermission(options);
    if (current === 'granted') {
      return true;
    }
  }
  if (typeof handle.requestPermission === 'function') {
    const requested = await handle.requestPermission(options);
    return requested === 'granted';
  }
  // If browser omits permission query/request helpers, proceed and let write verify access
  return true;
}

async function writeFileToDirectory(
  handle: FileSystemDirectoryHandleLike,
  fileName: string,
  jsonContent: string
): Promise<void> {
  const fileHandle = await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(jsonContent);
  } finally {
    await writable.close();
  }
}

function getErrorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    return String((err as { name: unknown }).name);
  }
  return '';
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Saves a complete JSON backup directly to the user's chosen local disk folder
 * via the File System Access API, remembering the FileSystemDirectoryHandle in
 * IndexedDB for one-click automatic backups on subsequent clicks.
 *
 * Falls back to classic `<a download>` when `window.showDirectoryPicker` is not
 * supported (e.g. Firefox / Safari).
 */
export async function saveBackupToDisk(
  db: AppDatabase,
  uiState: PersistedUiState,
  options?: { forcePickDirectory?: boolean }
): Promise<DiskBackupResult> {
  const now = new Date();
  const fileName = buildBackupFilename(now);
  const timestamp = formatBackupDateTime(now);
  const jsonContent = buildFullBackupJson(db, uiState, now);

  if (!supportsDirectoryPicker()) {
    try {
      triggerClassicDownload(jsonContent, fileName);
      return {
        status: 'downloaded_fallback',
        fileName,
        timestamp,
        reason: 'unsupported_browser',
      };
    } catch (err) {
      return {
        status: 'error',
        message: `Impossibile scaricare il backup: ${getErrorMessage(err)}`,
      };
    }
  }

  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker!;
  let dirHandle: FileSystemDirectoryHandleLike | null = null;
  let pickedNow = false;

  if (!options?.forcePickDirectory) {
    try {
      dirHandle = await readBackupDirectoryHandle();
    } catch {
      dirHandle = null;
    }
  }

  // First time (or explicit folder re-selection): ask user to choose the folder
  if (!dirHandle) {
    try {
      dirHandle = await picker({
        id: 'testmark-backups',
        mode: 'readwrite',
      });
      pickedNow = true;
    } catch (err) {
      const name = getErrorName(err);
      if (name === 'AbortError') {
        return { status: 'cancelled' };
      }
      if (name === 'SecurityError') {
        // Cross-origin iframe restriction (e.g. embedded preview): fall back to download
        try {
          triggerClassicDownload(jsonContent, fileName);
          return {
            status: 'downloaded_fallback',
            fileName,
            timestamp,
            reason: 'iframe_restricted',
          };
        } catch (dlErr) {
          return {
            status: 'error',
            message: `Accesso alla cartella bloccato e download fallito: ${getErrorMessage(dlErr)}`,
          };
        }
      }
      return {
        status: 'error',
        message: `Impossibile selezionare la cartella di backup: ${getErrorMessage(err)}`,
      };
    }

    // Store handle in IndexedDB so subsequent clicks save automatically
    try {
      await writeBackupDirectoryHandle(dirHandle);
    } catch {
      // Non-fatal: still complete this backup write even if handle persistence fails
    }
  } else {
    // Subsequent clicks: verify permission without opening the folder picker
    try {
      const granted = await ensureReadWritePermission(dirHandle);
      if (!granted) {
        return {
          status: 'permission_or_folder_error',
          folderName: dirHandle.name,
          message: `Permesso di scrittura negato o revocato per la cartella "${dirHandle.name}". Scegli di nuovo la cartella di backup.`,
        };
      }
    } catch (err) {
      const name = getErrorName(err);
      if (name === 'NotFoundError' || name === 'NotAllowedError' || name === 'InvalidStateError') {
        await clearBackupDirectoryHandle().catch(() => {});
        return {
          status: 'permission_or_folder_error',
          folderName: dirHandle.name,
          message: `La cartella "${dirHandle.name}" non è più accessibile (${getErrorMessage(err)}). Scegli di nuovo la cartella.`,
        };
      }
      return {
        status: 'error',
        message: `Errore verifica permessi sulla cartella "${dirHandle.name}": ${getErrorMessage(err)}`,
      };
    }
  }

  // Write the actual backup file to disk
  try {
    await writeFileToDirectory(dirHandle, fileName, jsonContent);
    return {
      status: 'saved_to_folder',
      folderName: dirHandle.name,
      fileName,
      timestamp,
    };
  } catch (err) {
    const name = getErrorName(err);
    if (
      !pickedNow &&
      (name === 'NotFoundError' || name === 'NotAllowedError' || name === 'InvalidStateError')
    ) {
      await clearBackupDirectoryHandle().catch(() => {});
      return {
        status: 'permission_or_folder_error',
        folderName: dirHandle.name,
        message: `La cartella "${dirHandle.name}" non è più disponibile o i permessi sono stati revocati. Scegli di nuovo la cartella.`,
      };
    }
    return {
      status: 'error',
      message: `Errore durante la scrittura del backup in "${dirHandle.name}": ${getErrorMessage(err)}`,
    };
  }
}
