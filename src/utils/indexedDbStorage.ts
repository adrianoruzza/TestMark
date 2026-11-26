import { AppDatabase } from '../types';

const IDB_NAME = 'TestMarkDB';
const IDB_VERSION = 1;
const STORE_APP_DATA = 'app_data';
const STORE_BACKUP_HANDLES = 'backup_handles';

const KEY_MAIN_DATABASE = 'main_database';
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

interface MainDatabaseRecord {
  id: typeof KEY_MAIN_DATABASE;
  db: AppDatabase;
  savedAt: string;
}

interface BackupDirectoryRecord {
  id: typeof KEY_BACKUP_DIRECTORY;
  handle: FileSystemDirectoryHandleLike;
  folderName: string;
  savedAt: string;
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;

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

function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
  return openIndexedDB().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result as T | undefined);
          req.onerror = () =>
            reject(
              req.error ?? new Error(`Errore lettura IndexedDB (${storeName}/${key}).`)
            );
          tx.onabort = () =>
            reject(
              tx.error ?? new Error(`Transazione di lettura interrotta (${storeName}).`)
            );
        } catch (err) {
          cachedDbPromise = null;
          reject(err);
        }
      })
  );
}

function putRecord<T>(storeName: string, value: T): Promise<void> {
  return openIndexedDB().then(
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
              tx.error ?? new Error(`Transazione di scrittura interrotta (${storeName}).`)
            );
        } catch (err) {
          cachedDbPromise = null;
          reject(err);
        }
      })
  );
}

function deleteRecord(storeName: string, key: string): Promise<void> {
  return openIndexedDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(
              tx.error ?? new Error(`Errore rimozione IndexedDB (${storeName}/${key}).`)
            );
          tx.onabort = () =>
            reject(
              tx.error ?? new Error(`Transazione di rimozione interrotta (${storeName}).`)
            );
        } catch (err) {
          cachedDbPromise = null;
          reject(err);
        }
      })
  );
}

// Serialize database writes so rapid user edits always commit in strict order
let writeQueue: Promise<void> = Promise.resolve();

export function readMainDatabaseFromIndexedDB(): Promise<AppDatabase | null> {
  return getRecord<MainDatabaseRecord>(STORE_APP_DATA, KEY_MAIN_DATABASE).then(
    (record) => record?.db ?? null
  );
}

export function writeMainDatabaseToIndexedDB(db: AppDatabase): Promise<void> {
  const record: MainDatabaseRecord = {
    id: KEY_MAIN_DATABASE,
    db,
    savedAt: db.updatedAt || new Date().toISOString(),
  };

  const task = writeQueue
    .catch(() => {
      // Keep queue running even if a previous write failed
    })
    .then(() => putRecord(STORE_APP_DATA, record));

  writeQueue = task;
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
