import { AppDatabase } from '../types';

/**
 * Deterministic JSON serialization with sorted object keys so identical logical states
 * always produce the exact same hash across devices, browsers, and sessions.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}

/**
 * Computes a canonical fingerprint of the AppDatabase content (excluding volatile updatedAt
 * and activeClassId UI navigation selection) so we never trigger spurious uploads when
 * the user merely switches tabs/classes.
 */
export function canonicalDatabaseContent(db: AppDatabase): string {
  const normalized = {
    version: db.version,
    classes: [...db.classes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((cls) => ({
        id: cls.id,
        name: cls.name,
        schoolYear: cls.schoolYear,
        minimums: cls.minimums,
        includeArchivedInCount: cls.includeArchivedInCount,
        createdAt: cls.createdAt,
        activities: [...cls.activities]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((a) => ({
            id: a.id,
            title: a.title,
            category: a.category,
            date: a.date,
            notes: a.notes ?? '',
            createdAt: a.createdAt,
          })),
        students: [...cls.students]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((s) => ({
            id: s.id,
            lastName: s.lastName,
            firstName: s.firstName,
            notes: s.notes ?? '',
            createdAt: s.createdAt,
            records: s.records,
            archivedHistory: [...s.archivedHistory].sort((a, b) =>
              a.id.localeCompare(b.id)
            ),
          })),
      })),
  };
  return stableStringify(normalized);
}

/**
 * Fast synchronous 64-bit FNV-1a hex hash (dual-lane) for synchronous dirty-checking.
 */
export function quickHashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + ((i & 0xff) << 1);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

export function computeDatabaseHash(db: AppDatabase): string {
  return quickHashString(canonicalDatabaseContent(db));
}

/**
 * Cryptographic SHA-256 hex checksum using Web Crypto API (with graceful fallback).
 */
export async function computeSha256Hex(input: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoded = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback below if subtle crypto is unavailable in an insecure context
  }
  return `fnv_${quickHashString(input)}_${input.length}`;
}
