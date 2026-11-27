import { createSeedDatabase } from '../data/seedData';
import {
  ActivityCategory,
  AppDatabase,
  AppView,
  CATEGORY_ORDER,
  DEFAULT_MINIMUMS,
  SchoolClass,
} from '../types';
import {
  MainDatabaseSnapshot,
  readMainDatabaseSnapshotFromIndexedDB,
  readPreviousDatabaseSnapshotFromIndexedDB,
  requestPersistentStorage,
  writeMainDatabaseSnapshotToIndexedDB,
} from './indexedDbStorage';

const STORAGE_KEY = 'registro_prove_app_db_v1';
const UI_STATE_STORAGE_KEY = 'testmark_ui_state_v1';

export interface PersistedUiState {
  view: AppView;
  searchQuery: string;
  categoryFilter: ActivityCategory | 'ALL';
  requirementFilter: 'ALL' | 'OK' | 'CARENZA';
}

export const DEFAULT_UI_STATE: PersistedUiState = {
  view: 'registro',
  searchQuery: '',
  categoryFilter: 'ALL',
  requirementFilter: 'ALL',
};

function sanitizeUiState(raw: unknown): PersistedUiState {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_UI_STATE };
  }

  const candidate = raw as Partial<PersistedUiState>;
  const validViews: AppView[] = ['registro', 'resoconto', 'archivio'];
  const view: AppView =
    typeof candidate.view === 'string' &&
    validViews.includes(candidate.view as AppView)
      ? (candidate.view as AppView)
      : DEFAULT_UI_STATE.view;

  const searchQuery =
    typeof candidate.searchQuery === 'string' ? candidate.searchQuery : '';

  const categoryFilter: ActivityCategory | 'ALL' =
    candidate.categoryFilter === 'ALL' ||
    (typeof candidate.categoryFilter === 'string' &&
      CATEGORY_ORDER.includes(candidate.categoryFilter as ActivityCategory))
      ? (candidate.categoryFilter as ActivityCategory | 'ALL')
      : 'ALL';

  const requirementFilter: 'ALL' | 'OK' | 'CARENZA' =
    candidate.requirementFilter === 'ALL' ||
    candidate.requirementFilter === 'OK' ||
    candidate.requirementFilter === 'CARENZA'
      ? candidate.requirementFilter
      : 'ALL';

  return {
    view,
    searchQuery,
    categoryFilter,
    requirementFilter,
  };
}

function sanitizeClass(raw: Partial<SchoolClass>): SchoolClass | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null;
  }

  return {
    id: raw.id,
    name: raw.name.trim() || 'Classe senza nome',
    schoolYear:
      typeof raw.schoolYear === 'string' && raw.schoolYear.trim()
        ? raw.schoolYear.trim()
        : '2026/2027',
    minimums: {
      COMPITO_GRAFICO: Math.max(
        0,
        Number(raw.minimums?.COMPITO_GRAFICO ?? DEFAULT_MINIMUMS.COMPITO_GRAFICO)
      ),
      INTERROGAZIONE_ORALE: Math.max(
        0,
        Number(
          raw.minimums?.INTERROGAZIONE_ORALE ??
            DEFAULT_MINIMUMS.INTERROGAZIONE_ORALE
        )
      ),
      CONSEGNA_PRATICO: Math.max(
        0,
        Number(raw.minimums?.CONSEGNA_PRATICO ?? DEFAULT_MINIMUMS.CONSEGNA_PRATICO)
      ),
    },
    includeArchivedInCount:
      typeof raw.includeArchivedInCount === 'boolean'
        ? raw.includeArchivedInCount
        : true,
    activities: Array.isArray(raw.activities) ? raw.activities : [],
    students: Array.isArray(raw.students)
      ? raw.students.map((s) => ({
          ...s,
          records: s.records && typeof s.records === 'object' ? s.records : {},
          archivedHistory: Array.isArray(s.archivedHistory)
            ? s.archivedHistory
            : [],
        }))
      : [],
    createdAt:
      typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

function validateDatabase(raw: unknown): AppDatabase | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<AppDatabase>;
  if (!Array.isArray(candidate.classes)) return null;

  const classes = candidate.classes
    .map((c) => sanitizeClass(c))
    .filter((c): c is SchoolClass => c !== null);

  const activeClassId =
    candidate.activeClassId && classes.some((c) => c.id === candidate.activeClassId)
      ? candidate.activeClassId
      : classes[0]?.id ?? null;

  return {
    version: 1,
    updatedAt:
      typeof candidate.updatedAt === 'string'
        ? candidate.updatedAt
        : new Date().toISOString(),
    activeClassId,
    classes,
  };
}

interface LocalStorageMirrorSnapshot {
  db: AppDatabase;
  revision: number | null;
  isSeed: boolean;
}

function readLocalStorageMirrorSnapshot(): LocalStorageMirrorSnapshot | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const validated = validateDatabase(parsed);
    if (!validated) return null;
    const rawRev = parsed?._revision;
    const revision =
      typeof rawRev === 'number' && Number.isFinite(rawRev) ? rawRev : null;
    const isSeed = Boolean(parsed?._isSeed);
    return { db: validated, revision, isSeed };
  } catch {
    return null;
  }
}

/**
 * Reads a previously saved database from localStorage without ever overwriting
 * or mutating storage. Used strictly for legacy migration and emergency recovery.
 */
export function readLegacyLocalStorageDatabase(): AppDatabase | null {
  return readLocalStorageMirrorSnapshot()?.db ?? null;
}

/**
 * Best-effort synchronous mirror to localStorage used strictly as a crash/beforeunload
 * safety net alongside IndexedDB. Includes the monotonic revision counter so recovery
 * never relies on unreliable device wall-clock timestamps.
 */
export function saveDatabase(
  db: AppDatabase,
  revision = 1,
  isSeed = false
): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...db,
        _revision: revision,
        _isSeed: isSeed,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function readUiStateFromLocalStorage(): PersistedUiState {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_UI_STATE };
    }
    const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_STATE };
    return sanitizeUiState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

export function saveUiStateToLocalStorage(uiState: PersistedUiState): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      UI_STATE_STORAGE_KEY,
      JSON.stringify(sanitizeUiState(uiState))
    );
  } catch {
    // Ignore localStorage quota errors for UI preferences
  }
}

export interface InitialLoadResult {
  db: AppDatabase;
  revision: number;
  uiState: PersistedUiState;
  isFirstLaunch: boolean;
}

function validateSnapshot(
  snapshot: MainDatabaseSnapshot | null
): MainDatabaseSnapshot | null {
  if (!snapshot) return null;
  const validated = validateDatabase(snapshot.db);
  if (!validated) return null;
  return {
    ...snapshot,
    db: validated,
  };
}

/**
 * Startup loading sequence:
 * 1. Requests durable browser storage permission (best-effort)
 * 2. Reads main database snapshot from IndexedDB (falling back to atomic previous snapshot
 *    if main record was ever corrupted; throws on IndexedDB open/read error without deleting data)
 * 3. Uses revision-guarded reconciliation with localStorage mirror (NEVER compares wall-clock
 *    timestamps, preventing stale future-dated seed snapshots from overwriting user data)
 * 4. Creates demo seed data ONLY when zero valid saved data exists anywhere
 */
export async function loadInitialAppState(): Promise<InitialLoadResult> {
  void requestPersistentStorage();

  const rawIdbSnapshot = await readMainDatabaseSnapshotFromIndexedDB();
  let idbSnapshot = validateSnapshot(rawIdbSnapshot);

  // If main record existed in IndexedDB but failed validation, try atomic previous snapshot
  if (rawIdbSnapshot && !idbSnapshot) {
    const previousSnapshot = validateSnapshot(
      await readPreviousDatabaseSnapshotFromIndexedDB().catch(() => null)
    );
    if (previousSnapshot) {
      idbSnapshot = previousSnapshot;
    } else {
      throw new Error(
        'I dati trovati in IndexedDB hanno una struttura non valida. Nessun dato è stato eliminato o sovrascritto.'
      );
    }
  }

  const lsMirror = readLocalStorageMirrorSnapshot();
  const uiState = readUiStateFromLocalStorage();

  // Case 1: Both IndexedDB and localStorage mirror exist
  if (idbSnapshot && lsMirror) {
    // Promote localStorage ONLY if it carries a strictly higher monotonic revision
    // (e.g. an emergency synchronous beforeunload save completed milliseconds before tab close)
    const mirrorIsStrictlyNewer =
      lsMirror.revision !== null &&
      !lsMirror.isSeed &&
      lsMirror.revision > idbSnapshot.revision;

    if (mirrorIsStrictlyNewer && lsMirror.revision !== null) {
      const committed = await writeMainDatabaseSnapshotToIndexedDB(
        lsMirror.db,
        lsMirror.revision,
        { isSeed: false, allowSameRevision: true }
      );
      return {
        db: committed.db,
        revision: committed.revision,
        uiState,
        isFirstLaunch: false,
      };
    }

    // IndexedDB is primary source of truth — refresh localStorage mirror so stale data cannot linger
    saveDatabase(idbSnapshot.db, idbSnapshot.revision, idbSnapshot.isSeed);
    return {
      db: idbSnapshot.db,
      revision: idbSnapshot.revision,
      uiState,
      isFirstLaunch: false,
    };
  }

  // Case 2: Saved data exists in IndexedDB (primary archive)
  if (idbSnapshot) {
    saveDatabase(idbSnapshot.db, idbSnapshot.revision, idbSnapshot.isSeed);
    return {
      db: idbSnapshot.db,
      revision: idbSnapshot.revision,
      uiState,
      isFirstLaunch: false,
    };
  }

  // Case 3: Existing user migrating from earlier localStorage-only version or recovering after IDB wipe
  if (lsMirror) {
    const targetRev = lsMirror.revision !== null ? Math.max(1, lsMirror.revision) : 1;
    const committed = await writeMainDatabaseSnapshotToIndexedDB(
      lsMirror.db,
      targetRev,
      { isSeed: lsMirror.isSeed, allowSameRevision: true }
    );
    saveDatabase(committed.db, committed.revision, committed.isSeed);
    return {
      db: committed.db,
      revision: committed.revision,
      uiState,
      isFirstLaunch: false,
    };
  }

  // Case 4: Very first launch ever (zero saved data anywhere) — initialize once with default data
  const seed = createSeedDatabase();
  const committed = await writeMainDatabaseSnapshotToIndexedDB(seed, 0, {
    isSeed: true,
    allowSameRevision: true,
  });
  saveDatabase(committed.db, committed.revision, true);
  saveUiStateToLocalStorage(uiState);
  return {
    db: committed.db,
    revision: committed.revision,
    uiState,
    isFirstLaunch: true,
  };
}

/**
 * Persists the full database immediately to IndexedDB (primary archive)
 * with monotonic revision protection, and updates the synchronous localStorage mirror.
 */
export function persistDatabaseImmediately(
  db: AppDatabase,
  revision: number
): Promise<MainDatabaseSnapshot> {
  saveDatabase(db, revision, false);
  return writeMainDatabaseSnapshotToIndexedDB(db, revision, { isSeed: false });
}

/**
 * Reads the latest committed snapshot from IndexedDB (used for cross-tab sync).
 */
export async function readLatestCommittedDatabase(): Promise<{
  db: AppDatabase;
  revision: number;
} | null> {
  const snapshot = validateSnapshot(
    await readMainDatabaseSnapshotFromIndexedDB().catch(() => null)
  );
  if (!snapshot) return null;
  return { db: snapshot.db, revision: snapshot.revision };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function exportDatabaseBackupJson(db: AppDatabase): void {
  const now = new Date();
  const payload = JSON.stringify(
    {
      ...db,
      exportedAt: now.toISOString(),
      application: 'TestMark',
    },
    null,
    2
  );
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const fileName = `TestMark_Backup_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}.json`;
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function parseBackupFile(file: File): Promise<AppDatabase> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Il file selezionato non è un file JSON valido.');
  }

  const validated = validateDatabase(parsed);
  if (!validated) {
    throw new Error(
      'Struttura del backup non riconosciuta. Assicurati di caricare un file esportato da TestMark.'
    );
  }

  return validated;
}
