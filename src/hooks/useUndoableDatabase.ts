import { useCallback, useEffect, useRef, useState } from 'react';
import { AppDatabase, SchoolClass } from '../types';
import {
  DEFAULT_UI_STATE,
  PersistedUiState,
  loadInitialAppState,
  persistDatabaseImmediately,
  readLatestCommittedDatabase,
  readLegacyLocalStorageDatabase,
  saveDatabase,
  saveUiStateToLocalStorage,
} from '../utils/storage';

const MAX_HISTORY_STEPS = 100;
const SYNC_CHANNEL_NAME = 'testmark_db_sync_v1';

export type SaveStatus = 'saving' | 'saved' | 'error';

interface HistorySnapshot {
  classes: SchoolClass[];
  activeClassId: string | null;
  label: string;
}

interface UndoableState {
  db: AppDatabase;
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

const EMPTY_PLACEHOLDER_DB: AppDatabase = {
  version: 1,
  updatedAt: '',
  activeClassId: null,
  classes: [],
};

function reconcileActiveClassId(
  currentActiveId: string | null,
  fallbackActiveId: string | null,
  classes: SchoolClass[]
): string | null {
  if (classes.length === 0) return null;
  if (currentActiveId && classes.some((c) => c.id === currentActiveId)) {
    return currentActiveId;
  }
  if (fallbackActiveId && classes.some((c) => c.id === fallbackActiveId)) {
    return fallbackActiveId;
  }
  return classes[0].id;
}

interface UseUndoableDatabaseOptions {
  getUiState?: () => PersistedUiState;
  onPersistError?: (message: string) => void;
}

export function useUndoableDatabase(options: UseUndoableDatabaseOptions = {}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasEmergencyFallback, setHasEmergencyFallback] = useState(false);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [state, setState] = useState<UndoableState>({
    db: EMPTY_PLACEHOLDER_DB,
    past: [],
    future: [],
  });

  const stateRef = useRef<UndoableState>(state);
  stateRef.current = state;

  // Guard: NEVER write to IndexedDB or localStorage until hydration succeeds
  const isHydratedRef = useRef(false);
  const revisionRef = useRef(0);
  const pendingWritesRef = useRef(0);
  const hasUnsavedChangesRef = useRef(false);
  const tabIdRef = useRef(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
  const channelRef = useRef<BroadcastChannel | null>(null);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const persistDbNow = useCallback((nextDb: AppDatabase, nextRevision: number) => {
    if (!isHydratedRef.current) return;

    hasUnsavedChangesRef.current = true;
    pendingWritesRef.current += 1;
    setSaveStatus('saving');
    setSaveError(null);

    void persistDatabaseImmediately(nextDb, nextRevision)
      .then((committed) => {
        pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
        revisionRef.current = Math.max(revisionRef.current, committed.revision);

        if (pendingWritesRef.current === 0) {
          hasUnsavedChangesRef.current = false;
          setSaveStatus('saved');
          setLastSavedAt(committed.savedAt);
          setSaveError(null);
        }

        try {
          channelRef.current?.postMessage({
            type: 'db_updated',
            revision: committed.revision,
            tabId: tabIdRef.current,
          });
        } catch {
          // Ignore BroadcastChannel postMessage failures
        }
      })
      .catch((err) => {
        pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1);
        hasUnsavedChangesRef.current = true;
        const msg =
          err instanceof Error
            ? err.message
            : 'Errore durante il salvataggio automatico in IndexedDB.';
        setSaveStatus('error');
        setSaveError(msg);
        optionsRef.current.onPersistError?.(
          `Salvataggio automatico non riuscito: ${msg}`
        );
      });
  }, []);

  const retrySave = useCallback(() => {
    if (!isHydratedRef.current) return;
    const nextRev = revisionRef.current + 1;
    revisionRef.current = nextRev;
    const nextDb: AppDatabase = {
      ...stateRef.current.db,
      updatedAt: new Date().toISOString(),
    };
    stateRef.current = { ...stateRef.current, db: nextDb };
    setState(stateRef.current);
    persistDbNow(nextDb, nextRev);
  }, [persistDbNow]);

  const runLoad = useCallback(async () => {
    isHydratedRef.current = false;
    hasUnsavedChangesRef.current = false;
    pendingWritesRef.current = 0;
    setStatus('loading');
    setLoadError(null);
    setHasEmergencyFallback(false);

    try {
      const result = await loadInitialAppState();
      const loadedState: UndoableState = {
        db: result.db,
        past: [],
        future: [],
      };
      revisionRef.current = result.revision;
      stateRef.current = loadedState;
      setState(loadedState);
      setLastSavedAt(result.db.updatedAt || new Date().toISOString());
      setSaveStatus('saved');
      setSaveError(null);
      isHydratedRef.current = true;
      setStatus('ready');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Errore sconosciuto durante il caricamento da IndexedDB.';
      setLoadError(message);
      setHasEmergencyFallback(Boolean(readLegacyLocalStorageDatabase()));
      setStatus('error');
    }
  }, []);

  // Load saved data from IndexedDB on startup
  useEffect(() => {
    void runLoad();
  }, [runLoad]);

  // Cross-tab synchronization so two open tabs/PWA windows never overwrite each other
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
    } catch {
      return;
    }
    channelRef.current = channel;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; revision?: number; tabId?: string }
        | undefined;
      if (
        !data ||
        data.type !== 'db_updated' ||
        data.tabId === tabIdRef.current ||
        !isHydratedRef.current
      ) {
        return;
      }
      if (
        typeof data.revision === 'number' &&
        data.revision > revisionRef.current &&
        !hasUnsavedChangesRef.current
      ) {
        void readLatestCommittedDatabase().then((latest) => {
          if (
            !latest ||
            latest.revision <= revisionRef.current ||
            hasUnsavedChangesRef.current
          ) {
            return;
          }
          revisionRef.current = latest.revision;
          const syncedState: UndoableState = {
            db: latest.db,
            past: [],
            future: [],
          };
          stateRef.current = syncedState;
          setState(syncedState);
          setLastSavedAt(latest.db.updatedAt);
          setSaveStatus('saved');
          setSaveError(null);
        });
      }
    };

    channel.addEventListener('message', handleMessage);
    return () => {
      channel.removeEventListener('message', handleMessage);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  // Emergency save on page close/hide ONLY when unsaved changes exist (never blind overwrite)
  useEffect(() => {
    const flushIfDirty = () => {
      if (!isHydratedRef.current) return;

      const currentUi = optionsRef.current.getUiState
        ? optionsRef.current.getUiState()
        : DEFAULT_UI_STATE;
      saveUiStateToLocalStorage(currentUi);

      if (!hasUnsavedChangesRef.current) return;

      const currentDb = stateRef.current.db;
      const rev = revisionRef.current;
      saveDatabase(currentDb, rev, false);
      void persistDatabaseImmediately(currentDb, rev).catch(() => {});
    };

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      flushIfDirty();
      // Warn only if an IndexedDB write is still in flight or previously failed
      if (pendingWritesRef.current > 0 || hasUnsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushIfDirty();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', flushIfDirty);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', flushIfDirty);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const recoverFromLocalFallback = useCallback(() => {
    const fallback = readLegacyLocalStorageDatabase();
    if (!fallback) return;
    const loadedState: UndoableState = {
      db: fallback,
      past: [],
      future: [],
    };
    revisionRef.current = Math.max(1, revisionRef.current);
    stateRef.current = loadedState;
    setState(loadedState);
    isHydratedRef.current = true;
    setLoadError(null);
    setSaveStatus('saved');
    setLastSavedAt(fallback.updatedAt);
    setStatus('ready');
  }, []);

  /**
   * Commit a significant data mutation to the database, record it in UNDO history,
   * and persist immediately to IndexedDB with monotonic revision tracking.
   */
  const commitChange = useCallback(
    (label: string, updater: (prev: AppDatabase) => AppDatabase) => {
      if (!isHydratedRef.current) return;
      const prevDb = stateRef.current.db;
      const nextDbRaw = updater(prevDb);
      if (nextDbRaw === prevDb) return;

      const nextDb: AppDatabase = {
        ...nextDbRaw,
        updatedAt: new Date().toISOString(),
      };

      const snapshot: HistorySnapshot = {
        classes: prevDb.classes,
        activeClassId: prevDb.activeClassId,
        label,
      };

      const currentPast = stateRef.current.past;
      const nextPast =
        currentPast.length >= MAX_HISTORY_STEPS
          ? [
              ...currentPast.slice(currentPast.length - MAX_HISTORY_STEPS + 1),
              snapshot,
            ]
          : [...currentPast, snapshot];

      const nextRevision = revisionRef.current + 1;
      revisionRef.current = nextRevision;

      const nextState: UndoableState = {
        db: nextDb,
        past: nextPast,
        future: [],
      };
      stateRef.current = nextState;
      setState(nextState);
      persistDbNow(nextDb, nextRevision);
    },
    [persistDbNow]
  );

  /**
   * Update non-historical navigation state (switching the active class)
   * and persist immediately to IndexedDB without adding to UNDO/REDO history.
   */
  const setActiveClassId = useCallback(
    (classId: string | null) => {
      if (!isHydratedRef.current) return;
      const prevState = stateRef.current;
      if (prevState.db.activeClassId === classId) return;

      const nextDb: AppDatabase = {
        ...prevState.db,
        activeClassId: classId,
        updatedAt: new Date().toISOString(),
      };
      const nextRevision = revisionRef.current + 1;
      revisionRef.current = nextRevision;

      const nextState: UndoableState = {
        ...prevState,
        db: nextDb,
      };
      stateRef.current = nextState;
      setState(nextState);
      persistDbNow(nextDb, nextRevision);
    },
    [persistDbNow]
  );

  const undo = useCallback((): string | null => {
    if (!isHydratedRef.current) return null;
    const current = stateRef.current;
    if (current.past.length === 0) return null;

    const previous = current.past[current.past.length - 1];
    const nextPast = current.past.slice(0, -1);

    const redoSnapshot: HistorySnapshot = {
      classes: current.db.classes,
      activeClassId: current.db.activeClassId,
      label: previous.label,
    };

    const nextActiveId = reconcileActiveClassId(
      previous.activeClassId,
      current.db.activeClassId,
      previous.classes
    );

    const nextDb: AppDatabase = {
      ...current.db,
      classes: previous.classes,
      activeClassId: nextActiveId,
      updatedAt: new Date().toISOString(),
    };

    const nextRevision = revisionRef.current + 1;
    revisionRef.current = nextRevision;

    const nextState: UndoableState = {
      db: nextDb,
      past: nextPast,
      future: [...current.future, redoSnapshot],
    };

    stateRef.current = nextState;
    setState(nextState);
    persistDbNow(nextDb, nextRevision);
    return previous.label;
  }, [persistDbNow]);

  const redo = useCallback((): string | null => {
    if (!isHydratedRef.current) return null;
    const current = stateRef.current;
    if (current.future.length === 0) return null;

    const next = current.future[current.future.length - 1];
    const nextFuture = current.future.slice(0, -1);

    const undoSnapshot: HistorySnapshot = {
      classes: current.db.classes,
      activeClassId: current.db.activeClassId,
      label: next.label,
    };

    const nextActiveId = reconcileActiveClassId(
      next.activeClassId,
      current.db.activeClassId,
      next.classes
    );

    const nextDb: AppDatabase = {
      ...current.db,
      classes: next.classes,
      activeClassId: nextActiveId,
      updatedAt: new Date().toISOString(),
    };

    const nextRevision = revisionRef.current + 1;
    revisionRef.current = nextRevision;

    const nextState: UndoableState = {
      db: nextDb,
      past: [...current.past, undoSnapshot],
      future: nextFuture,
    };

    stateRef.current = nextState;
    setState(nextState);
    persistDbNow(nextDb, nextRevision);
    return next.label;
  }, [persistDbNow]);

  return {
    status,
    loadError,
    hasEmergencyFallback,
    retryLoad: runLoad,
    recoverFromLocalFallback,
    saveStatus,
    lastSavedAt,
    saveError,
    retrySave,
    db: state.db,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    nextUndoLabel: state.past[state.past.length - 1]?.label ?? null,
    nextRedoLabel: state.future[state.future.length - 1]?.label ?? null,
    commitChange,
    setActiveClassId,
    undo,
    redo,
  };
}
