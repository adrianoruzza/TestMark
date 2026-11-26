import { useCallback, useEffect, useRef, useState } from 'react';
import { AppDatabase, SchoolClass } from '../types';
import {
  DEFAULT_UI_STATE,
  PersistedUiState,
  loadInitialAppState,
  persistDatabaseImmediately,
  readLegacyLocalStorageDatabase,
  saveDatabase,
  saveUiStateToLocalStorage,
} from '../utils/storage';

const MAX_HISTORY_STEPS = 100;

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
  onHydratedUiState?: (uiState: PersistedUiState) => void;
  onPersistError?: (message: string) => void;
}

export function useUndoableDatabase(options: UseUndoableDatabaseOptions = {}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasEmergencyFallback, setHasEmergencyFallback] = useState(false);

  const [state, setState] = useState<UndoableState>({
    db: EMPTY_PLACEHOLDER_DB,
    past: [],
    future: [],
  });

  const stateRef = useRef<UndoableState>(state);
  stateRef.current = state;

  // Guard: NEVER write to IndexedDB or localStorage until hydration succeeds
  const isHydratedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const persistDbNow = useCallback((nextDb: AppDatabase) => {
    if (!isHydratedRef.current) return;
    void persistDatabaseImmediately(nextDb).catch((err) => {
      const msg =
        err instanceof Error
          ? err.message
          : 'Errore durante il salvataggio automatico in IndexedDB.';
      optionsRef.current.onPersistError?.(
        `Attenzione: salvataggio automatico in IndexedDB non riuscito (${msg}).`
      );
    });
  }, []);

  const runLoad = useCallback(async () => {
    isHydratedRef.current = false;
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
      stateRef.current = loadedState;
      setState(loadedState);
      optionsRef.current.onHydratedUiState?.(result.uiState);
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

  // Emergency save on page close (beforeunload / pagehide) and tab hide (visibilitychange)
  useEffect(() => {
    const flushEmergencySave = () => {
      if (!isHydratedRef.current) return;
      const currentDb = stateRef.current.db;
      const currentUi = optionsRef.current.getUiState
        ? optionsRef.current.getUiState()
        : DEFAULT_UI_STATE;

      // Synchronous localStorage save (UI state + DB safety mirror) + immediate IndexedDB flush for DB
      saveDatabase(currentDb);
      saveUiStateToLocalStorage(currentUi);
      void persistDatabaseImmediately(currentDb).catch(() => {});
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushEmergencySave();
      }
    };

    window.addEventListener('beforeunload', flushEmergencySave);
    window.addEventListener('pagehide', flushEmergencySave);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', flushEmergencySave);
      window.removeEventListener('pagehide', flushEmergencySave);
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
    stateRef.current = loadedState;
    setState(loadedState);
    isHydratedRef.current = true;
    setLoadError(null);
    setStatus('ready');
  }, []);

  /**
   * Commit a significant data mutation to the database, record it in UNDO history,
   * and persist immediately to IndexedDB.
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

      const nextState: UndoableState = {
        db: nextDb,
        past: nextPast,
        future: [],
      };
      stateRef.current = nextState;
      setState(nextState);
      persistDbNow(nextDb);
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
      const nextState: UndoableState = {
        ...prevState,
        db: nextDb,
      };
      stateRef.current = nextState;
      setState(nextState);
      persistDbNow(nextDb);
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

    const nextState: UndoableState = {
      db: nextDb,
      past: nextPast,
      future: [...current.future, redoSnapshot],
    };

    stateRef.current = nextState;
    setState(nextState);
    persistDbNow(nextDb);
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

    const nextState: UndoableState = {
      db: nextDb,
      past: [...current.past, undoSnapshot],
      future: nextFuture,
    };

    stateRef.current = nextState;
    setState(nextState);
    persistDbNow(nextDb);
    return next.label;
  }, [persistDbNow]);

  return {
    status,
    loadError,
    hasEmergencyFallback,
    retryLoad: runLoad,
    recoverFromLocalFallback,
    db: state.db,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    nextUndoLabel: state.past[state.past.length - 1]?.label ?? null,
    nextRedoLabel: state.future[state.future.length - 1]?.label ?? null,
    undoCount: state.past.length,
    redoCount: state.future.length,
    commitChange,
    setActiveClassId,
    undo,
    redo,
  };
}
