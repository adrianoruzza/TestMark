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
  readMainDatabaseFromIndexedDB,
  requestPersistentStorage,
  writeMainDatabaseToIndexedDB,
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

/**
 * Reads a previously saved database from localStorage without ever overwriting
 * or mutating storage. Used strictly for legacy migration and emergency close recovery.
 */
export function readLegacyLocalStorageDatabase(): AppDatabase | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateDatabase(parsed);
  } catch {
    return null;
  }
}

/**
 * Best-effort synchronous mirror to localStorage used strictly as a crash/beforeunload
 * safety net alongside IndexedDB. Silently returns false if quota is exceeded.
 */
export function saveDatabase(db: AppDatabase): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    return true;
  } catch {
    return false;
  }
}

function readUiStateFromLocalStorage(): PersistedUiState | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeUiState(JSON.parse(raw));
  } catch {
    return null;
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

interface InitialLoadResult {
  db: AppDatabase;
  uiState: PersistedUiState;
  isFirstLaunch: boolean;
}

function parseTimestampMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Startup loading sequence:
 * 1. Requests durable browser storage permission (best-effort)
 * 2. Reads main database from IndexedDB (throws if IndexedDB fails; never deletes data)
 *    and UI preferences (last view & filters) from localStorage
 * 3. Uses saved IndexedDB data immediately (or migrates legacy localStorage data if present)
 * 4. Creates demo seed data ONLY on the very first launch when zero saved data exists
 */
export async function loadInitialAppState(): Promise<InitialLoadResult> {
  void requestPersistentStorage();

  const idbRawDb = await readMainDatabaseFromIndexedDB();

  const idbDb = idbRawDb ? validateDatabase(idbRawDb) : null;
  if (idbRawDb && !idbDb) {
    throw new Error(
      'I dati trovati in IndexedDB hanno una struttura non valida. Nessun dato è stato eliminato o sovrascritto.'
    );
  }

  const legacyLsDb = readLegacyLocalStorageDatabase();
  const uiState = readUiStateFromLocalStorage() ?? { ...DEFAULT_UI_STATE };

  // Case 1: Both IndexedDB and localStorage mirror exist — keep the most recently updated snapshot
  if (idbDb && legacyLsDb) {
    if (parseTimestampMs(legacyLsDb.updatedAt) > parseTimestampMs(idbDb.updatedAt)) {
      await writeMainDatabaseToIndexedDB(legacyLsDb);
      return { db: legacyLsDb, uiState, isFirstLaunch: false };
    }
    return { db: idbDb, uiState, isFirstLaunch: false };
  }

  // Case 2: Saved data exists in IndexedDB (primary archive)
  if (idbDb) {
    return { db: idbDb, uiState, isFirstLaunch: false };
  }

  // Case 3: Existing user migrating from earlier localStorage-only version
  if (legacyLsDb) {
    await writeMainDatabaseToIndexedDB(legacyLsDb);
    return { db: legacyLsDb, uiState, isFirstLaunch: false };
  }

  // Case 4: Very first launch ever (no saved data anywhere) — initialize once with demo data
  const seed = createSeedDatabase();
  await writeMainDatabaseToIndexedDB(seed);
  saveDatabase(seed);
  saveUiStateToLocalStorage(uiState);
  return { db: seed, uiState, isFirstLaunch: true };
}

/**
 * Persists the full database immediately to IndexedDB (primary archive)
 * and updates the synchronous localStorage mirror as a fast crash fallback.
 */
export function persistDatabaseImmediately(db: AppDatabase): Promise<void> {
  saveDatabase(db);
  return writeMainDatabaseToIndexedDB(db);
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
