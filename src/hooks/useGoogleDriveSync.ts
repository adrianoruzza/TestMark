import { useCallback, useEffect, useRef, useState } from 'react';
import { driveBackupService } from '../services/driveBackup';
import { googleAuth } from '../services/googleAuth';
import { googleDrive } from '../services/googleDrive';
import {
  TestMarkSyncEngine,
  getSyncIndicatorText,
} from '../services/syncEngine';
import {
  AuthState,
  DriveBackupItem,
  DriveBackupPayload,
  SyncSnapshotState,
} from '../services/syncTypes';
import { AppDatabase } from '../types';

export interface UseGoogleDriveSyncParams {
  getLocalDatabase: () => AppDatabase;
  applyRemoteDatabase: (nextDb: AppDatabase, reason: string) => void;
  onStatusToast?: (message: string) => void;
}

export interface GoogleDriveSyncController {
  authState: AuthState;
  syncState: SyncSnapshotState;
  syncIndicatorText: string;
  backups: DriveBackupItem[];
  loadingBackups: boolean;
  creatingBackup: boolean;
  restoringBackup: boolean;
  backupError: string | null;
  signIn: () => Promise<void>;
  reconnectDrive: () => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<void>;
  resolveConflict: (conflictId: string, choice: 'local' | 'remote') => void;
  refreshBackups: () => Promise<void>;
  createManualBackup: () => Promise<DriveBackupItem | null>;
  inspectBackup: (item: DriveBackupItem) => Promise<DriveBackupPayload>;
  restoreDriveBackup: (item: DriveBackupItem) => Promise<boolean>;
  notifyLocalChange: (prevDb: AppDatabase, nextDb: AppDatabase, label: string) => void;
}

const VISIBILITY_SYNC_COOLDOWN_MS = 30_000;

export function useGoogleDriveSync({
  getLocalDatabase,
  applyRemoteDatabase,
  onStatusToast,
}: UseGoogleDriveSyncParams): GoogleDriveSyncController {
  const getDbRef = useRef(getLocalDatabase);
  getDbRef.current = getLocalDatabase;

  const applyRemoteRef = useRef(applyRemoteDatabase);
  applyRemoteRef.current = applyRemoteDatabase;

  const toastRef = useRef(onStatusToast);
  toastRef.current = onStatusToast;

  const engineRef = useRef<TestMarkSyncEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new TestMarkSyncEngine({
      auth: googleAuth,
      drive: googleDrive,
      getLocalDatabase: () => getDbRef.current(),
      applyRemoteDatabase: (nextDb, reason) => applyRemoteRef.current(nextDb, reason),
    });
  }

  const [authState, setAuthState] = useState<AuthState>(() => googleAuth.getState());
  const [syncState, setSyncState] = useState<SyncSnapshotState>(() =>
    engineRef.current!.getSnapshot()
  );

  const [backups, setBackups] = useState<DriveBackupItem[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const prevAuthStatusRef = useRef<AuthState['status']>(authState.status);
  const lastVisibilitySyncRef = useRef<number>(0);

  const refreshBackups = useCallback(async () => {
    const currentAuth = googleAuth.getState();
    if (currentAuth.status !== 'authenticated' || !currentAuth.hasDriveAccess) {
      return;
    }
    setLoadingBackups(true);
    setBackupError(null);
    try {
      const items = await driveBackupService.listBackups();
      setBackups(items);
    } catch (err) {
      setBackupError(
        err instanceof Error
          ? err.message
          : 'Impossibile leggere i backup da SYNC_TestMark/BACKUP.'
      );
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  useEffect(() => {
    const engine = engineRef.current!;
    googleAuth.init();

    const unsubSync = engine.subscribe((nextSync) => {
      setSyncState(nextSync);
    });

    const unsubAuth = googleAuth.subscribe((nextAuth) => {
      setAuthState(nextAuth);
      const prevStatus = prevAuthStatusRef.current;
      prevAuthStatusRef.current = nextAuth.status;

      if (
        nextAuth.status === 'authenticated' &&
        nextAuth.hasDriveAccess &&
        prevStatus !== 'authenticated'
      ) {
        engine.handleAuthReady();
        void refreshBackups();
      } else if (nextAuth.status === 'signed_out' && prevStatus !== 'signed_out') {
        engine.handleSignedOut();
        setBackups([]);
        setBackupError(null);
      }
    });

    const onOnline = () => engine.handleConnectivityChange(true);
    const onOffline = () => engine.handleConnectivityChange(false);
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastVisibilitySyncRef.current < VISIBILITY_SYNC_COOLDOWN_MS) return;
      const curAuth = googleAuth.getState();
      if (navigator.onLine && curAuth.status === 'authenticated' && curAuth.hasDriveAccess) {
        lastVisibilitySyncRef.current = now;
        void engine.syncNow({ reason: 'visibility' });
      }
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubSync();
      unsubAuth();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshBackups]);

  const signIn = useCallback(async () => {
    const res = await googleAuth.signIn({ forceAccountSelect: true });
    if (res.status === 'authenticated' && res.hasDriveAccess) {
      toastRef.current?.('Google Drive collegato — sincronizzazione avviata');
    } else if (res.errorMessage) {
      toastRef.current?.(res.errorMessage);
    }
  }, []);

  const reconnectDrive = useCallback(async () => {
    const res = await googleAuth.reconnectDrive();
    if (res.status === 'authenticated' && res.hasDriveAccess) {
      toastRef.current?.('Autorizzazione Google Drive ripristinata');
    } else if (res.errorMessage) {
      toastRef.current?.(res.errorMessage);
    }
  }, []);

  const signOut = useCallback(async () => {
    await googleAuth.signOut({ revokeToken: false });
    toastRef.current?.('Account Google disconnesso (i dati locali restano salvati)');
  }, []);

  const syncNow = useCallback(async () => {
    const engine = engineRef.current!;
    const res = await engine.syncNow({ reason: 'manual' });
    if (res.ok) {
      if (res.conflictsDetected > 0) {
        toastRef.current?.(
          `Sincronizzato con ${res.conflictsDetected} conflitt${
            res.conflictsDetected === 1 ? 'o' : 'i'
          } da verificare`
        );
      } else if (res.action === 'pulled' || res.action === 'merged') {
        toastRef.current?.('Dati aggiornati da Google Drive');
      } else {
        toastRef.current?.('Sincronizzazione completata');
      }
      void refreshBackups();
    } else if (res.error) {
      toastRef.current?.(res.error);
    }
  }, [refreshBackups]);

  const resolveConflict = useCallback(
    (conflictId: string, choice: 'local' | 'remote') => {
      const ok = engineRef.current!.resolveConflict(conflictId, choice);
      if (ok) {
        toastRef.current?.(
          choice === 'local'
            ? 'Conflitto risolto: mantenuta versione locale'
            : 'Conflitto risolto: applicata versione remota'
        );
      }
    },
    []
  );

  const createManualBackup = useCallback(async (): Promise<DriveBackupItem | null> => {
    const currentAuth = googleAuth.getState();
    if (currentAuth.status !== 'authenticated' || !currentAuth.hasDriveAccess) {
      setBackupError('Collega Google Drive prima di creare un backup.');
      return null;
    }

    setCreatingBackup(true);
    setBackupError(null);
    try {
      const created = await driveBackupService.createBackup(
        getDbRef.current(),
        engineRef.current!.getDeviceId()
      );
      setBackups((prev) => [created, ...prev.filter((b) => b.fileId !== created.fileId)]);
      toastRef.current?.(`Backup verificato creato in SYNC_TestMark/BACKUP`);
      return created;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Errore durante la creazione del backup su Google Drive.';
      setBackupError(msg);
      toastRef.current?.(msg);
      return null;
    } finally {
      setCreatingBackup(false);
    }
  }, []);

  const inspectBackup = useCallback(
    async (item: DriveBackupItem): Promise<DriveBackupPayload> => {
      return driveBackupService.inspectBackup(item);
    },
    []
  );

  const restoreDriveBackup = useCallback(
    async (item: DriveBackupItem): Promise<boolean> => {
      setRestoringBackup(true);
      setBackupError(null);
      try {
        const result = await driveBackupService.restoreBackup(
          item,
          getDbRef.current(),
          engineRef.current!.getDeviceId()
        );
        applyRemoteRef.current(
          result.restoredDatabase,
          `Ripristinato ${item.name} (backup preventivo creato)`
        );
        engineRef.current!.notifyRestoredDatabase(result.restoredDatabase, item.name);
        setBackups((prev) => [
          result.safetyBackup,
          ...prev.filter((b) => b.fileId !== result.safetyBackup.fileId),
        ]);
        return true;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Errore durante il ripristino del backup da Google Drive.';
        setBackupError(msg);
        toastRef.current?.(msg);
        return false;
      } finally {
        setRestoringBackup(false);
      }
    },
    []
  );

  const notifyLocalChange = useCallback(
    (prevDb: AppDatabase, nextDb: AppDatabase, label: string) => {
      engineRef.current?.notifyLocalChange(prevDb, nextDb, label);
    },
    []
  );

  return {
    authState,
    syncState,
    syncIndicatorText: getSyncIndicatorText(syncState),
    backups,
    loadingBackups,
    creatingBackup,
    restoringBackup,
    backupError,
    signIn,
    reconnectDrive,
    signOut,
    syncNow,
    resolveConflict,
    refreshBackups,
    createManualBackup,
    inspectBackup,
    restoreDriveBackup,
    notifyLocalChange,
  };
}
