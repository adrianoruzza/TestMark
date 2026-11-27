import { AppDatabase } from '../types';

const IDB_NAME = 'TestMarkDB';
const IDB_VERSION = 1;
const STORE_APP_DATA = 'app_data';
const STORE_BACKUP_HANDLES = 'backup_handles';

const KEY_MAIN_DATABASE = 'main_database';
const KEY_PREVIOUS_DATABASE = 'main_database_previous';
const KEY_BACKUP_DIRECTORY = 'backup_directory';

interface FileSystemPermissionDescriptorLike {
  mode?: 'read' | 'readwrite';
}

interface FileSystemWritableFileStreamLike {
  write: (data: string | Blob | ArrayBuffer | ArrayBufferView) => Promise<void>;
  close: () => Promise<void>;
}

interface FileSystemFileHandleLike {
  kind: 'file';
  name: string;
  createWritable: () => Promise<FileSystemWritableFileStreamLike>;
}

export interface FileSystemDirectoryHandleLike {
  kind: 'directory';
  name: string;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<FileSystemFileHandleLike>;
  queryPermission?: (
    descriptor?: FileSystemPermissionDescriptorLike
  ) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (
    descriptor?: FileSystemPermissionDescriptorLike
  ) => Promise<'granted' | 'denied' | 'prompt'>;
}

export interface MainDatabaseSnapshot {
  db: AppDatabase;
  revision: number;
  savedAt: string;
  isSeed: boolean;
}

interface MainDatabaseRecord {
  id: typeof KEY_MAIN_DATABASE | typeof KEY_PREVIOUS_DATABASE;
  db: AppDatabase;
  revision?: number;
  savedAt?: string;
  isSeed?: boolean;
}

interface BackupDirectoryRecord {
  id: typeof KEY_BACKUP_DIRECTORY;
  handle: FileSystemDirectoryHandleLike;
  folderName: string;
  savedAt: string;
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function resetCachedConnection(): void {
  const existing = cachedDbPromise;
  cachedDbPromise = null;
  if (existing) {
    void existing
      .then((db) => {
        try {
          db.close();
        } catch {
          // Ignore close errors on already-closed connections
        }
      })
      .catch(() => {});
  }
}

function isRetriableConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String((err as { name: unknown }).name) : '';
  const message =
    'message' in err ? String((err as { message: unknown }).message) : '';
  return (
    name === 'InvalidStateError' ||
    name === 'TransactionInactiveError' ||
    name === 'AbortError' ||
    /closing|closed|connection/i.test(message)
  );
}

function openIndexedDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('IndexedDB non è disponibile in questo browser o contesto.')
    );
  }

  if (cachedDbPromise) {
    return cachedDbPromise;
  }

  cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch (err) {
      cachedDbPromise = null;
      reject(
        err instanceof Error
          ? err
          : new Error('Impossibile aprire il database locale IndexedDB.')
      );
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_APP_DATA)) {
        db.createObjectStore(STORE_APP_DATA, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BACKUP_HANDLES)) {
        db.createObjectStore(STORE_BACKUP_HANDLES, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        cachedDbPromise = null;
      };
      db.onclose = () => {
        cachedDbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      cachedDbPromise = null;
      reject(
        request.error ??
          new Error('Errore durante l’apertura del database locale IndexedDB.')
      );
    };

    request.onblocked = () => {
      cachedDbPromise = null;
      reject(
        new Error(
          'Il database locale è bloccato da un’altra scheda aperta. Chiudi le altre schede di TestMark e riprova.'
        )
      );
    };
  });

  return cachedDbPromise;
}

async function withReconnectRetry<T>(
  operation: (db: IDBDatabase) => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      const db = await openIndexedDB();
      return await operation(db);
    } catch (err) {
      if (attempt < maxRetries && isRetriableConnectionError(err)) {
        attempt += 1;
        resetCachedConnection();
        await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
        continue;
      }
      if (isRetriableConnectionError(err)) {
        resetCachedConnection();
      }
      throw err;
    }
  }
}

function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
  return withReconnectRetry(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result as T | undefined);
          req.onerror = () =>
            reject(
              req.error ??
                new Error(`Errore lettura IndexedDB (${storeName}/${key}).`)
            );
          tx.onabort = () =>
            reject(
              tx.error ??
                new Error(`Transazione di lettura interrotta (${storeName}).`)
            );
        } catch (err) {
          reject(err);
        }
      })
  );
}

function putRecord<T>(storeName: string, value: T): Promise<void> {
  return withReconnectRetry(
    (db) =>
      new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.put(value);
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(
              tx.error ?? new Error(`Errore scrittura IndexedDB (${storeName}).`)
            );
          tx.onabort = () =>
            reject(
              tx.error ??
                new Error(`Transazione di scrittura interrotta (${storeName}).`)
            );
        } catch (err) {
          reject(err);
        }
      })
  );
}

function deleteRecord(storeName: string, key: string): Promise<void> {
  return withReconnectRetry(
    (db) =>
      new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(
              tx.error ??
                new Error(`Errore rimozione IndexedDB (${storeName}/${key}).`)
            );
          tx.onabort = () =>
            reject(
              tx.error ??
                new Error(`Transazione di rimozione interrotta (${storeName}).`)
            );
        } catch (err) {
          reject(err);
        }
      })
  );
}

function toSnapshot(record: MainDatabaseRecord | undefined): MainDatabaseSnapshot | null {
  if (!record || !record.db) return null;
  return {
    db: record.db,
    // Legacy records written before revision tracking are preserved as revision 1 (never treated as seed)
    revision:
      typeof record.revision === 'number' && Number.isFinite(record.revision)
        ? record.revision
        : 1,
    savedAt: record.savedAt || record.db.updatedAt || new Date().toISOString(),
    isSeed: Boolean(record.isSeed),
  };
}

// Serialize database writes so rapid user edits always commit in strict order
let writeQueue: Promise<void> = Promise.resolve();

export function readMainDatabaseSnapshotFromIndexedDB(): Promise<MainDatabaseSnapshot | null> {
  return getRecord<MainDatabaseRecord>(STORE_APP_DATA, KEY_MAIN_DATABASE).then(
    toSnapshot
  );
}

export function readPreviousDatabaseSnapshotFromIndexedDB(): Promise<MainDatabaseSnapshot | null> {
  return getRecord<MainDatabaseRecord>(STORE_APP_DATA, KEY_PREVIOUS_DATABASE).then(
    toSnapshot
  );
}

/**
 * Atomically writes the main database snapshot to IndexedDB, archiving the
 * previous valid snapshot under `main_database_previous` in the same transaction
 * and preventing stale tabs from overwriting a strictly higher revision.
 */
export function writeMainDatabaseSnapshotToIndexedDB(
  db: AppDatabase,
  revision: number,
  options?: { isSeed?: boolean; allowSameRevision?: boolean }
): Promise<MainDatabaseSnapshot> {
  const savedAt = db.updatedAt || new Date().toISOString();
  const nextSnapshot: MainDatabaseSnapshot = {
    db,
    revision,
    savedAt,
    isSeed: Boolean(options?.isSeed),
  };

  const runWrite = () =>
    withReconnectRetry<MainDatabaseSnapshot>(
      (idb) =>
        new Promise<MainDatabaseSnapshot>((resolve, reject) => {
          try {
            const tx = idb.transaction(STORE_APP_DATA, 'readwrite');
            const store = tx.objectStore(STORE_APP_DATA);
            const readReq = store.get(KEY_MAIN_DATABASE);
            let committedSnapshot = nextSnapshot;

            readReq.onsuccess = () => {
              const existing = readReq.result as MainDatabaseRecord | undefined;
              const existingRev =
                existing &&
                typeof existing.revision === 'number' &&
                Number.isFinite(existing.revision)
                  ? existing.revision
                  : existing?.db
                    ? 1
                    : -1;

              // Guard against a stale tab or premature seed write overwriting newer committed data
              const isStaleWrite = options?.allowSameRevision
                ? existingRev > revision
                : existingRev >= revision && existingRev > 0;

              if (isStaleWrite && existing?.db) {
                committedSnapshot = toSnapshot(existing) ?? nextSnapshot;
                return;
              }

              // Keep previous valid non-seed state as an atomic rollback safety copy inside IndexedDB
              if (existing?.db && !existing.isSeed) {
                const previousRecord: MainDatabaseRecord = {
                  id: KEY_PREVIOUS_DATABASE,
                  db: existing.db,
                  revision: existingRev,
                  savedAt: existing.savedAt || existing.db.updatedAt,
                  isSeed: false,
                };
                store.put(previousRecord);
              }

              const nextRecord: MainDatabaseRecord = {
                id: KEY_MAIN_DATABASE,
                db,
                revision,
                savedAt,
                isSeed: Boolean(options?.isSeed),
              };
              store.put(nextRecord);
            };

            readReq.onerror = () =>
              reject(
                readReq.error ??
                  new Error('Errore durante la verifica pre-salvataggio in IndexedDB.')
              );

            tx.oncomplete = () => resolve(committedSnapshot);
            tx.onerror = () =>
              reject(
                tx.error ??
                  new Error('Errore durante il salvataggio in IndexedDB.')
              );
            tx.onabort = () =>
              reject(
                tx.error ??
                  new Error('Transazione di salvataggio interrotta in IndexedDB.')
              );
          } catch (err) {
            reject(err);
          }
        })
    );

  const task = writeQueue
    .catch(() => {
      // Keep queue running even if a previous write failed
    })
    .then(runWrite);

  writeQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

export function readBackupDirectoryHandle(): Promise<FileSystemDirectoryHandleLike | null> {
  return getRecord<BackupDirectoryRecord>(
    STORE_BACKUP_HANDLES,
    KEY_BACKUP_DIRECTORY
  ).then((record) => record?.handle ?? null);
}

export function writeBackupDirectoryHandle(
  handle: FileSystemDirectoryHandleLike
): Promise<void> {
  const record: BackupDirectoryRecord = {
    id: KEY_BACKUP_DIRECTORY,
    handle,
    folderName: handle.name,
    savedAt: new Date().toISOString(),
  };
  return putRecord(STORE_BACKUP_HANDLES, record);
}

export function clearBackupDirectoryHandle(): Promise<void> {
  return deleteRecord(STORE_BACKUP_HANDLES, KEY_BACKUP_DIRECTORY);
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.persist === 'function'
    ) {
      const alreadyPersisted =
        typeof navigator.storage.persisted === 'function'
          ? await navigator.storage.persisted()
          : false;
      if (alreadyPersisted) return true;
      return await navigator.storage.persist();
    }
  } catch {
    // Ignore unsupported storage persistence requests
  }
  return false;
}
