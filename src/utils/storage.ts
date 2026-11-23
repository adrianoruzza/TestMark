import { createSeedDatabase } from '../data/seedData';
import { AppDatabase, DEFAULT_MINIMUMS, SchoolClass } from '../types';

export const STORAGE_KEY = 'registro_prove_app_db_v1';

function sanitizeClass(raw: Partial<SchoolClass>): SchoolClass | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    return null;
  }

  return {
    id: raw.id,
    name: raw.name.trim() || 'Classe senza nome',
    schoolYear: typeof raw.schoolYear === 'string' && raw.schoolYear.trim() ? raw.schoolYear.trim() : '2026/2027',
    minimums: {
      COMPITO_GRAFICO: Math.max(
        0,
        Number(raw.minimums?.COMPITO_GRAFICO ?? DEFAULT_MINIMUMS.COMPITO_GRAFICO)
      ),
      INTERROGAZIONE_ORALE: Math.max(
        0,
        Number(raw.minimums?.INTERROGAZIONE_ORALE ?? DEFAULT_MINIMUMS.INTERROGAZIONE_ORALE)
      ),
      CONSEGNA_PRATICO: Math.max(
        0,
        Number(raw.minimums?.CONSEGNA_PRATICO ?? DEFAULT_MINIMUMS.CONSEGNA_PRATICO)
      ),
    },
    includeArchivedInCount:
      typeof raw.includeArchivedInCount === 'boolean' ? raw.includeArchivedInCount : true,
    activities: Array.isArray(raw.activities) ? raw.activities : [],
    students: Array.isArray(raw.students)
      ? raw.students.map((s) => ({
          ...s,
          records: s.records && typeof s.records === 'object' ? s.records : {},
          archivedHistory: Array.isArray(s.archivedHistory) ? s.archivedHistory : [],
        }))
      : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

export function validateDatabase(raw: unknown): AppDatabase | null {
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
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    activeClassId,
    classes,
  };
}

export function loadDatabase(): AppDatabase {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seed = createSeedDatabase();
      saveDatabase(seed);
      return seed;
    }
    const parsed = JSON.parse(raw);
    const validated = validateDatabase(parsed);
    if (validated) {
      return validated;
    }
  } catch {
    // Fall back to seed data if storage is unavailable or corrupted
  }
  const seed = createSeedDatabase();
  saveDatabase(seed);
  return seed;
}

export function saveDatabase(db: AppDatabase): boolean {
  try {
    const payload: AppDatabase = {
      ...db,
      updatedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function exportDatabaseBackupJson(db: AppDatabase): void {
  const payload = JSON.stringify(
    {
      ...db,
      exportedAt: new Date().toISOString(),
      application: 'Registro Prove',
    },
    null,
    2
  );
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const dateStr = new Date().toISOString().slice(0, 10);
  const link = document.createElement('a');
  link.href = url;
  link.download = `registro-prove-backup-${dateStr}.json`;
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
      'Struttura del backup non riconosciuta. Assicurati di caricare un file esportato da Registro Prove.'
    );
  }

  return validated;
}
