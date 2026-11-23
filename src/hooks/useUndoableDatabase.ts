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

export function useUndoableDatabase() {
  const [state, setState] = useState<UndoableState>(() => ({
    db: loadDatabase(),
    past: [],
    future: [],
  }));

  const stateRef = useRef<UndoableState>(state);
  stateRef.current = state;

  // Persist every committed state (including undo/redo restorations) automatically
  useEffect(() => {
    saveDatabase(state.db);
  }, [state.db]);

  /**
   * Commit a significant data mutation to the database and record it in UNDO history.
   * Clears any pending REDO entries.
   */
  const commitChange = useCallback(
    (label: string, updater: (prev: AppDatabase) => AppDatabase) => {
      setState((prevState) => {
        const nextDbRaw = updater(prevState.db);
        if (nextDbRaw === prevState.db) return prevState;

        const nextDb: AppDatabase = {
          ...nextDbRaw,
          updatedAt: new Date().toISOString(),
        };

        const snapshot: HistorySnapshot = {
          classes: prevState.db.classes,
          activeClassId: prevState.db.activeClassId,
          label,
        };

        const nextPast =
          prevState.past.length >= MAX_HISTORY_STEPS
            ? [...prevState.past.slice(prevState.past.length - MAX_HISTORY_STEPS + 1), snapshot]
            : [...prevState.past, snapshot];

        const nextState: UndoableState = {
          db: nextDb,
          past: nextPast,
          future: [],
        };
        stateRef.current = nextState;
        return nextState;
      });
    },
    []
  );

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

    const nextState: UndoableState = {
      db: {
        ...current.db,
        classes: previous.classes,
        activeClassId: nextActiveId,
        updatedAt: new Date().toISOString(),
      },
      past: nextPast,
      future: [...current.future, redoSnapshot],
    };

    stateRef.current = nextState;
    setState(nextState);
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

    const nextState: UndoableState = {
      db: {
        ...current.db,
        classes: next.classes,
        activeClassId: nextActiveId,
        updatedAt: new Date().toISOString(),
      },
      past: [...current.past, undoSnapshot],
      future: nextFuture,
    };

    stateRef.current = nextState;
    setState(nextState);
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
    setActiveClassId,
    undo,
    redo,
  };
}
