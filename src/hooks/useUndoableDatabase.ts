import { useCallback, useEffect, useRef, useState } from 'react';
import { AppDatabase, SchoolClass } from '../types';
import { loadDatabase, saveDatabase } from '../utils/storage';

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

export interface UseUndoableDatabaseOptions {
  onDataMutation?: (
    prevDb: AppDatabase,
    nextDb: AppDatabase,
    label: string
  ) => void;
}

export function useUndoableDatabase(options?: UseUndoableDatabaseOptions) {
  const [state, setState] = useState<UndoableState>(() => ({
    db: loadDatabase(),
    past: [],
    future: [],
  }));

  const stateRef = useRef<UndoableState>(state);
  stateRef.current = state;

  const onDataMutationRef = useRef(options?.onDataMutation);
  onDataMutationRef.current = options?.onDataMutation;

  // Persist every committed state (including undo/redo/sync restorations) automatically
  useEffect(() => {
    saveDatabase(state.db);
  }, [state.db]);

  /**
   * Commit a significant data mutation to the database and record it in UNDO history.
   * Clears any pending REDO entries.
   */
  const commitChange = useCallback(
    (label: string, updater: (prev: AppDatabase) => AppDatabase) => {
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
          ? [...currentPast.slice(currentPast.length - MAX_HISTORY_STEPS + 1), snapshot]
          : [...currentPast, snapshot];

      const nextState: UndoableState = {
        db: nextDb,
        past: nextPast,
        future: [],
      };
      stateRef.current = nextState;
      setState(nextState);
      onDataMutationRef.current?.(prevDb, nextDb, label);
    },
    []
  );

  /**
   * Apply a database received from Google Drive sync or conflict resolution without
   * triggering a redundant local-change loop.
   */
  const applyExternalDatabase = useCallback((nextDb: AppDatabase) => {
    setState((prevState) => {
      const nextActiveId = reconcileActiveClassId(
        prevState.db.activeClassId,
        nextDb.activeClassId,
        nextDb.classes
      );
      const normalized: AppDatabase = {
        ...nextDb,
        activeClassId: nextActiveId,
      };
      const nextState: UndoableState = {
        ...prevState,
        db: normalized,
      };
      stateRef.current = nextState;
      return nextState;
    });
  }, []);

  /**
   * Update non-historical navigation state (e.g., switching the active class)
   * without adding an entry to the UNDO/REDO history stack.
   */
  const setActiveClassId = useCallback((classId: string | null) => {
    setState((prevState) => {
      if (prevState.db.activeClassId === classId) return prevState;
      const nextState: UndoableState = {
        ...prevState,
        db: {
          ...prevState.db,
          activeClassId: classId,
        },
      };
      stateRef.current = nextState;
      return nextState;
    });
  }, []);

  const undo = useCallback((): string | null => {
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
    onDataMutationRef.current?.(current.db, nextDb, `Annulla: ${previous.label}`);
    return previous.label;
  }, []);

  const redo = useCallback((): string | null => {
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
    onDataMutationRef.current?.(current.db, nextDb, `Ripristina: ${next.label}`);
    return next.label;
  }, []);

  return {
    db: state.db,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    nextUndoLabel: state.past[state.past.length - 1]?.label ?? null,
    nextRedoLabel: state.future[state.future.length - 1]?.label ?? null,
    undoCount: state.past.length,
    redoCount: state.future.length,
    commitChange,
    applyExternalDatabase,
    setActiveClassId,
    undo,
    redo,
  };
}
