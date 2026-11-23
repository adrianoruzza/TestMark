import { createSeedDatabase } from '../data/seedData';
import { AppDatabase, generateId } from '../types';
import { validateDatabase } from '../utils/storage';
import { GoogleAuthManager, googleAuth } from './googleAuth';
import {
  GoogleDriveClient,
  GoogleDriveError,
  SYNC_STATE_FILENAME,
  googleDrive,
} from './googleDrive';
import {
  canonicalDatabaseContent,
  computeDatabaseHash,
  computeSha256Hex,
} from './syncHash';
import {
  applyConflictResolution,
  mergeDatabasesThreeWay,
  updateTombstonesFromDiff,
} from './syncMerge';
import {
  LocalSyncMetadata,
  RemoteSyncPayload,
  SyncConflict,
  SyncSnapshotState,
  SyncStatusCode,
  createEmptyTombstones,
} from './syncTypes';

export const SYNC_META_STORAGE_KEY = 'testmark_sync_meta_v1';
const DEFAULT_DEBOUNCE_MS = 2500;
const SEED_DB_HASH = computeDatabaseHash(createSeedDatabase());

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface SyncEngineOptions {
  auth?: GoogleAuthManager;
  drive?: GoogleDriveClient;
  storage?: StorageLike;
  isOnline?: () => boolean;
  debounceMs?: number;
  getLocalDatabase: () => AppDatabase;
  applyRemoteDatabase: (nextDb: AppDatabase, reason: string) => void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultStorage(): StorageLike {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
}

function formatConflictFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `conflict_TestMark_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

/**
 * Formats last sync timestamp into the exact required Italian format:
 * "Sincronizzato GG/MM/AAAA ore HH.MM"
 */
export function formatSyncedStatusLabel(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) {
    return 'Sincronizzato';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const hh = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `Sincronizzato ${dd}/${mm}/${yyyy} ore ${hh}.${min}`;
}

export function getSyncIndicatorText(snapshot: SyncSnapshotState): string {
  switch (snapshot.status) {
    case 'syncing':
      return 'Sincronizzazione in corso...';
    case 'pending':
      return 'Modifiche in attesa';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Errore sincronizzazione';
    case 'synced':
      return snapshot.lastSyncedAt
        ? formatSyncedStatusLabel(snapshot.lastSyncedAt)
        : 'Sincronizzato';
    case 'idle':
    default:
      return snapshot.lastSyncedAt
        ? formatSyncedStatusLabel(snapshot.lastSyncedAt)
        : 'Solo locale';
  }
}

export interface SyncRunResult {
  ok: boolean;
  action:
    | 'noop'
    | 'pushed'
    | 'pulled'
    | 'merged'
    | 'skipped_offline'
    | 'skipped_unauthenticated'
    | 'error';
  conflictsDetected: number;
  error?: string;
}

/**
 * Autonomous Local-First Multi-Device Sync Engine (Phase C).
 *
 * Guarantees:
 * - Local-first: every change is already persisted locally before sync starts.
 * - Debounced change queue persisted across reloads & crashes.
 * - Strict single-flight lock (zero parallel sync races).
 * - Automatic resume on network restoration and app reopen.
 * - 3-way merge with deletion tombstones & lossless conflict preservation.
 * - Status indicator updates ONLY when state truly changes, and marks 'synced'
 *   STRICTLY after Google Drive confirms the write/read.
 */
export class TestMarkSyncEngine {
  private readonly auth: GoogleAuthManager;
  private readonly drive: GoogleDriveClient;
  private readonly storage: StorageLike;
  private readonly isOnlineFn: () => boolean;
  private readonly debounceMs: number;
  private readonly getLocalDatabase: () => AppDatabase;
  private readonly applyRemoteDatabase: (nextDb: AppDatabase, reason: string) => void;

  private meta: LocalSyncMetadata;
  private snapshot: SyncSnapshotState;
  private listeners = new Set<(state: SyncSnapshotState) => void>();

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSyncPromise: Promise<SyncRunResult> | null = null;
  private followUpSyncRequested = false;
  private disposed = false;

  constructor(options: SyncEngineOptions) {
    this.auth = options.auth ?? googleAuth;
    this.drive = options.drive ?? googleDrive;
    this.storage = options.storage ?? defaultStorage();
    this.isOnlineFn =
      options.isOnline ??
      (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.getLocalDatabase = options.getLocalDatabase;
    this.applyRemoteDatabase = options.applyRemoteDatabase;

    this.meta = this.loadMetadata();
    const initialStatus = this.computeRestStatus();
    this.snapshot = {
      status: initialStatus,
      lastSyncedAt: this.meta.lastSyncedAt,
      pendingCount: this.meta.pendingQueue.length,
      lastError: null,
      conflicts: [...this.meta.conflicts],
      folderIds: {
        syncFolderId: this.drive.getCachedFolderIds()?.syncFolderId ?? null,
        backupFolderId: this.drive.getCachedFolderIds()?.backupFolderId ?? null,
      },
    };
  }

  public getDeviceId(): string {
    return this.meta.deviceId;
  }

  public getMetadata(): LocalSyncMetadata {
    return clone(this.meta);
  }

  public getSnapshot(): SyncSnapshotState {
    return {
      ...this.snapshot,
      conflicts: [...this.snapshot.conflicts],
      folderIds: { ...this.snapshot.folderIds },
    };
  }

  public subscribe(listener: (state: SyncSnapshotState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitIfChanged(next: SyncSnapshotState): void {
    const prev = this.snapshot;
    const same =
      prev.status === next.status &&
      prev.lastSyncedAt === next.lastSyncedAt &&
      prev.pendingCount === next.pendingCount &&
      prev.lastError === next.lastError &&
      prev.conflicts.length === next.conflicts.length &&
      prev.folderIds.syncFolderId === next.folderIds.syncFolderId &&
      prev.folderIds.backupFolderId === next.folderIds.backupFolderId &&
      prev.conflicts.every((c, idx) => c.id === next.conflicts[idx]?.id);

    if (same) return;

    this.snapshot = next;
    const copy = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(copy);
    }
  }

  private loadMetadata(): LocalSyncMetadata {
    try {
      const raw = this.storage.getItem(SYNC_META_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LocalSyncMetadata>;
        if (parsed && typeof parsed.deviceId === 'string') {
          return {
            schemaVersion: 1,
            deviceId: parsed.deviceId,
            lastSyncedRevision: Number(parsed.lastSyncedRevision || 0),
            lastSyncedHash:
              typeof parsed.lastSyncedHash === 'string'
                ? parsed.lastSyncedHash
                : null,
            lastSyncedAt:
              typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
            lastSyncedSnapshot: parsed.lastSyncedSnapshot
              ? validateDatabase(parsed.lastSyncedSnapshot)
              : null,
            pendingQueue: Array.isArray(parsed.pendingQueue)
              ? parsed.pendingQueue
              : [],
            tombstones: parsed.tombstones
              ? {
                  classes: parsed.tombstones.classes || {},
                  activities: parsed.tombstones.activities || {},
                  students: parsed.tombstones.students || {},
                  archivedEntries: parsed.tombstones.archivedEntries || {},
                }
              : createEmptyTombstones(),
            conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
          };
        }
      }
    } catch {
      // Fall through to clean metadata initialization
    }

    const fresh: LocalSyncMetadata = {
      schemaVersion: 1,
      deviceId: generateId('dev'),
      lastSyncedRevision: 0,
      lastSyncedHash: null,
      lastSyncedAt: null,
      lastSyncedSnapshot: null,
      pendingQueue: [],
      tombstones: createEmptyTombstones(),
      conflicts: [],
    };
    this.saveMetadata(fresh);
    return fresh;
  }

  private saveMetadata(meta: LocalSyncMetadata): void {
    this.meta = meta;
    try {
      this.storage.setItem(SYNC_META_STORAGE_KEY, JSON.stringify(meta));
    } catch {
      // If storage quota is tight, drop the base snapshot copy and retry compact metadata
      try {
        const compact: LocalSyncMetadata = {
          ...meta,
          lastSyncedSnapshot: null,
        };
        this.storage.setItem(SYNC_META_STORAGE_KEY, JSON.stringify(compact));
      } catch {
        // Never crash local-first editing
      }
    }
  }

  private computeRestStatus(): SyncStatusCode {
    if (!this.isOnlineFn()) return 'offline';
    const authState = this.auth.getState();
    const localHash = computeDatabaseHash(this.getLocalDatabase());
    const hasUnsynced =
      this.meta.pendingQueue.length > 0 ||
      (this.meta.lastSyncedHash !== null && localHash !== this.meta.lastSyncedHash);

    if (authState.status !== 'authenticated' || !authState.hasDriveAccess) {
      return hasUnsynced ? 'pending' : 'idle';
    }

    if (hasUnsynced) return 'pending';
    if (this.meta.lastSyncedAt) return 'synced';
    return 'idle';
  }

  private refreshStatusSnapshot(overrides?: Partial<SyncSnapshotState>): void {
    const folders = this.drive.getCachedFolderIds();
    const next: SyncSnapshotState = {
      status: overrides?.status ?? this.computeRestStatus(),
      lastSyncedAt:
        overrides?.lastSyncedAt !== undefined
          ? overrides.lastSyncedAt
          : this.meta.lastSyncedAt,
      pendingCount: this.meta.pendingQueue.length,
      lastError:
        overrides?.lastError !== undefined
          ? overrides.lastError
          : this.snapshot.lastError,
      conflicts: [...this.meta.conflicts],
      folderIds: {
        syncFolderId: folders?.syncFolderId ?? this.snapshot.folderIds.syncFolderId,
        backupFolderId:
          folders?.backupFolderId ?? this.snapshot.folderIds.backupFolderId,
      },
    };
    this.emitIfChanged(next);
  }

  /**
   * Called immediately whenever local data changes (edit, undo, redo, import, restore).
   * Persists the change queue locally and schedules a debounced Drive sync.
   */
  public notifyLocalChange(
    prevDb: AppDatabase,
    nextDb: AppDatabase,
    label: string
  ): void {
    if (this.disposed) return;

    const nextHash = computeDatabaseHash(nextDb);
    const updatedTombstones = updateTombstonesFromDiff(
      prevDb,
      nextDb,
      this.meta.tombstones
    );

    // If data reverted back to the exact last synced content, no upload is needed
    if (this.meta.lastSyncedHash && nextHash === this.meta.lastSyncedHash) {
      this.saveMetadata({
        ...this.meta,
        tombstones: updatedTombstones,
        pendingQueue: [],
      });
      this.clearDebounceTimer();
      this.refreshStatusSnapshot({ lastError: null });
      return;
    }

    const queuedEntry = {
      id: generateId('chg'),
      timestamp: new Date().toISOString(),
      label,
      dbHash: nextHash,
    };

    const nextQueue = [...this.meta.pendingQueue, queuedEntry].slice(-50);
    this.saveMetadata({
      ...this.meta,
      tombstones: updatedTombstones,
      pendingQueue: nextQueue,
    });

    if (this.activeSyncPromise) {
      this.followUpSyncRequested = true;
    }

    if (!this.isOnlineFn()) {
      this.clearDebounceTimer();
      this.refreshStatusSnapshot({ status: 'offline', lastError: null });
      return;
    }

    const authState = this.auth.getState();
    this.refreshStatusSnapshot({ status: 'pending', lastError: null });

    if (authState.status === 'authenticated' && authState.hasDriveAccess) {
      this.scheduleDebouncedSync();
    }
  }

  /**
   * Called after an explicit backup restore so the restored database becomes the new
   * authoritative local change and propagates cleanly to Drive (clearing obsolete tombstones).
   */
  public notifyRestoredDatabase(restoredDb: AppDatabase, backupName: string): void {
    const restoredHash = computeDatabaseHash(restoredDb);
    this.saveMetadata({
      ...this.meta,
      tombstones: createEmptyTombstones(),
      conflicts: [],
      lastSyncedSnapshot: null, // Force clean authoritative push on next sync
      pendingQueue: [
        {
          id: generateId('rst'),
          timestamp: new Date().toISOString(),
          label: `Ripristino ${backupName}`,
          dbHash: restoredHash,
        },
      ],
    });
    this.refreshStatusSnapshot({
      status: this.isOnlineFn() ? 'pending' : 'offline',
      lastError: null,
    });
    if (
      this.isOnlineFn() &&
      this.auth.getState().status === 'authenticated' &&
      this.auth.getState().hasDriveAccess
    ) {
      void this.syncNow({ reason: 'restore' });
    }
  }

  public handleConnectivityChange(online: boolean): void {
    if (this.disposed) return;
    if (!online) {
      this.clearDebounceTimer();
      this.refreshStatusSnapshot({ status: 'offline' });
      return;
    }

    // Back online: silently restore token if needed, then resume pending/remote sync
    void (async () => {
      const authReady = await this.auth.handleNetworkRestored();
      if (authReady) {
        await this.syncNow({ reason: 'reconnect' });
      } else {
        this.refreshStatusSnapshot();
      }
    })();
  }

  public handleAuthReady(): void {
    if (this.disposed) return;
    if (!this.isOnlineFn()) {
      this.refreshStatusSnapshot({ status: 'offline' });
      return;
    }
    void this.syncNow({ reason: 'auth_ready' });
  }

  public handleSignedOut(): void {
    this.clearDebounceTimer();
    this.drive.clearFolderCache();
    this.refreshStatusSnapshot({
      status: this.isOnlineFn() ? 'idle' : 'offline',
      lastError: null,
    });
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private scheduleDebouncedSync(): void {
    this.clearDebounceTimer();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow({ reason: 'debounced' });
    }, this.debounceMs);
  }

  /**
   * Executes one single-flight synchronization cycle with Google Drive (`SYNC_TestMark`).
   * Never runs two syncs in parallel; batches follow-up changes cleanly.
   */
  public syncNow(options?: { reason?: string; forcePush?: boolean }): Promise<SyncRunResult> {
    if (this.activeSyncPromise) {
      this.followUpSyncRequested = true;
      return this.activeSyncPromise;
    }

    this.clearDebounceTimer();
    this.activeSyncPromise = this.executeSyncCycle(options).finally(() => {
      this.activeSyncPromise = null;
      if (this.followUpSyncRequested && !this.disposed) {
        this.followUpSyncRequested = false;
        if (
          this.isOnlineFn() &&
          this.auth.getState().status === 'authenticated' &&
          this.auth.getState().hasDriveAccess
        ) {
          this.scheduleDebouncedSync();
        }
      }
    });

    return this.activeSyncPromise;
  }

  private async executeSyncCycle(options?: {
    reason?: string;
    forcePush?: boolean;
  }): Promise<SyncRunResult> {
    if (!this.isOnlineFn()) {
      this.refreshStatusSnapshot({ status: 'offline', lastError: null });
      return { ok: false, action: 'skipped_offline', conflictsDetected: 0 };
    }

    const authState = this.auth.getState();
    if (authState.status !== 'authenticated' || !authState.hasDriveAccess) {
      const token = await this.auth.getValidAccessToken();
      if (!token) {
        this.refreshStatusSnapshot({
          status: this.meta.pendingQueue.length > 0 ? 'pending' : 'idle',
        });
        return {
          ok: false,
          action: 'skipped_unauthenticated',
          conflictsDetected: 0,
        };
      }
    }

    this.refreshStatusSnapshot({ status: 'syncing', lastError: null });

    try {
      // 1. Verify SYNC_TestMark and BACKUP folders exist without duplicates
      const folders = await this.drive.ensureAppFolders();

      // 2. Read local snapshot at cycle start
      const localDb = clone(this.getLocalDatabase());
      const localHash = computeDatabaseHash(localDb);

      // 3. Check remote sync file strictly inside SYNC_TestMark
      const remoteFileMeta = await this.drive.findFileByName(
        'sync',
        SYNC_STATE_FILENAME
      );

      let remotePayload: RemoteSyncPayload | null = null;
      if (remoteFileMeta) {
        const remoteText = await this.drive.downloadTextFile(remoteFileMeta.id);
        remotePayload = await this.parseAndVerifyRemoteSync(remoteText);
      }

      const nowIso = new Date().toISOString();

      // CASE A: No remote sync file exists yet -> initial upload to SYNC_TestMark
      if (!remotePayload) {
        const revision = Math.max(this.meta.lastSyncedRevision + 1, 1);
        await this.uploadSyncPayload(localDb, revision, this.meta.tombstones);
        this.commitSyncedMetadata(localDb, revision, this.meta.tombstones, nowIso, []);
        this.refreshStatusSnapshot({
          status: 'synced',
          lastSyncedAt: nowIso,
          lastError: null,
          folderIds: {
            syncFolderId: folders.syncFolderId,
            backupFolderId: folders.backupFolderId,
          },
        });
        return { ok: true, action: 'pushed', conflictsDetected: 0 };
      }

      // CASE B: Explicit restore overwrite -> push restored local state directly as next revision
      if (options?.reason === 'restore' || options?.forcePush) {
        const revision = Math.max(
          remotePayload.revision,
          this.meta.lastSyncedRevision
        ) + 1;
        await this.uploadSyncPayload(localDb, revision, this.meta.tombstones);
        this.commitSyncedMetadata(localDb, revision, this.meta.tombstones, nowIso, []);
        this.refreshStatusSnapshot({
          status: 'synced',
          lastSyncedAt: nowIso,
          lastError: null,
        });
        return { ok: true, action: 'pushed', conflictsDetected: 0 };
      }

      // CASE C: Remote exists -> run deterministic 3-way merge
      const remoteHash = computeDatabaseHash(remotePayload.database);

      // Fast path: identical content and already aligned
      if (
        localHash === remoteHash &&
        this.meta.pendingQueue.length === 0 &&
        this.meta.lastSyncedHash === localHash
      ) {
        const confirmedAt = this.meta.lastSyncedAt || nowIso;
        this.commitSyncedMetadata(
          localDb,
          remotePayload.revision,
          this.meta.tombstones,
          confirmedAt,
          this.meta.conflicts
        );
        this.refreshStatusSnapshot({
          status: 'synced',
          lastSyncedAt: confirmedAt,
          lastError: null,
        });
        return { ok: true, action: 'noop', conflictsDetected: 0 };
      }

      const isLocalUntouchedSeed =
        this.meta.lastSyncedSnapshot === null &&
        this.meta.pendingQueue.length === 0 &&
        localHash === SEED_DB_HASH;

      const mergeResult = mergeDatabasesThreeWay({
        base: this.meta.lastSyncedSnapshot,
        local: localDb,
        remote: remotePayload.database,
        localTombstones: this.meta.tombstones,
        remoteTombstones: remotePayload.tombstones || createEmptyTombstones(),
        localUpdatedAt: localDb.updatedAt,
        remoteUpdatedAt: remotePayload.updatedAt || remotePayload.database.updatedAt,
        isLocalUntouchedSeed,
      });

      // Archive conflict snapshot on Drive so BOTH versions are preserved safely
      if (mergeResult.conflicts.length > 0) {
        const conflictArchive = JSON.stringify(
          {
            application: 'TestMark',
            kind: 'conflict_snapshot',
            detectedAt: nowIso,
            deviceId: this.meta.deviceId,
            conflicts: mergeResult.conflicts,
            localDatabase: localDb,
            remoteDatabase: remotePayload.database,
          },
          null,
          2
        );
        await this.drive
          .createJsonFileInFolder(
            'sync',
            formatConflictFileName(new Date()),
            conflictArchive,
            { application: 'TestMark', kind: 'conflict_snapshot' }
          )
          .catch(() => {
            // Local conflict state still preserves both snapshots even if archive write fails
          });
      }

      const nextConflicts = [
        ...this.meta.conflicts,
        ...mergeResult.conflicts,
      ];

      let finalRevision = remotePayload.revision;
      if (mergeResult.shouldPushRemote) {
        finalRevision = Math.max(remotePayload.revision, this.meta.lastSyncedRevision) + 1;
        await this.uploadSyncPayload(
          mergeResult.merged,
          finalRevision,
          mergeResult.tombstones
        );
      }

      if (mergeResult.changedLocally) {
        this.applyRemoteDatabase(
          mergeResult.merged,
          mergeResult.conflicts.length > 0
            ? 'Sincronizzazione completata con conflitti da verificare'
            : 'Dati aggiornati da Google Drive'
        );
      }

      this.commitSyncedMetadata(
        mergeResult.merged,
        finalRevision,
        mergeResult.tombstones,
        nowIso,
        nextConflicts
      );

      this.refreshStatusSnapshot({
        status: 'synced',
        lastSyncedAt: nowIso,
        lastError: null,
        folderIds: {
          syncFolderId: folders.syncFolderId,
          backupFolderId: folders.backupFolderId,
        },
      });

      const action =
        mergeResult.changedLocally && mergeResult.shouldPushRemote
          ? 'merged'
          : mergeResult.shouldPushRemote
            ? 'pushed'
            : mergeResult.changedLocally
              ? 'pulled'
              : 'noop';

      return {
        ok: true,
        action,
        conflictsDetected: mergeResult.conflicts.length,
      };
    } catch (err) {
      const offlineNow = !this.isOnlineFn();
      const message =
        err instanceof GoogleDriveError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Errore durante la sincronizzazione con Google Drive.';

      this.refreshStatusSnapshot({
        status: offlineNow ? 'offline' : 'error',
        lastError: offlineNow ? null : message,
      });

      return {
        ok: false,
        action: offlineNow ? 'skipped_offline' : 'error',
        conflictsDetected: 0,
        error: message,
      };
    }
  }

  private async uploadSyncPayload(
    db: AppDatabase,
    revision: number,
    tombstones: LocalSyncMetadata['tombstones']
  ): Promise<void> {
    const canonical = canonicalDatabaseContent(db);
    const checksum = await computeSha256Hex(canonical);
    const payload: RemoteSyncPayload = {
      application: 'TestMark',
      schemaVersion: 1,
      revision,
      updatedAt: db.updatedAt || new Date().toISOString(),
      updatedByDeviceId: this.meta.deviceId,
      checksum,
      tombstones,
      database: db,
    };

    const json = JSON.stringify(payload);
    const uploaded = await this.drive.upsertJsonFileInSyncFolder(
      SYNC_STATE_FILENAME,
      json,
      {
        application: 'TestMark',
        kind: 'sync_state',
        revision: String(revision),
        checksum,
        updatedByDeviceId: this.meta.deviceId,
      }
    );

    if (!uploaded.id || (uploaded.size !== undefined && Number(uploaded.size) <= 0)) {
      throw new GoogleDriveError(
        'invalid_response',
        'Caricamento sincronizzazione incompleto su Google Drive.'
      );
    }
  }

  private async parseAndVerifyRemoteSync(rawText: string): Promise<RemoteSyncPayload> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new GoogleDriveError(
        'invalid_response',
        'File di sincronizzazione remoto danneggiato (JSON non valido).'
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new GoogleDriveError(
        'invalid_response',
        'Struttura file di sincronizzazione remoto non valida.'
      );
    }

    const candidate = parsed as Partial<RemoteSyncPayload>;
    const validatedDb = validateDatabase(candidate.database);
    if (!validatedDb) {
      throw new GoogleDriveError(
        'invalid_response',
        'Database remoto non riconosciuto.'
      );
    }

    if (candidate.checksum) {
      const actual = await computeSha256Hex(canonicalDatabaseContent(validatedDb));
      if (actual !== candidate.checksum) {
        throw new GoogleDriveError(
          'invalid_response',
          'Verifica integrità file di sincronizzazione remoto fallita (checksum).'
        );
      }
    }

    return {
      application: 'TestMark',
      schemaVersion: Number(candidate.schemaVersion || 1),
      revision: Number(candidate.revision || 1),
      updatedAt:
        typeof candidate.updatedAt === 'string'
          ? candidate.updatedAt
          : validatedDb.updatedAt,
      updatedByDeviceId:
        typeof candidate.updatedByDeviceId === 'string'
          ? candidate.updatedByDeviceId
          : 'remote',
      checksum: candidate.checksum || '',
      tombstones: candidate.tombstones
        ? {
            classes: candidate.tombstones.classes || {},
            activities: candidate.tombstones.activities || {},
            students: candidate.tombstones.students || {},
            archivedEntries: candidate.tombstones.archivedEntries || {},
          }
        : createEmptyTombstones(),
      database: validatedDb,
    };
  }

  private commitSyncedMetadata(
    syncedDb: AppDatabase,
    revision: number,
    tombstones: LocalSyncMetadata['tombstones'],
    syncedAtIso: string,
    conflicts: SyncConflict[]
  ): void {
    const syncedHash = computeDatabaseHash(syncedDb);
    // Preserve any queue entries added *after* this sync started with a different hash
    const currentLocalHash = computeDatabaseHash(this.getLocalDatabase());
    const remainingQueue =
      currentLocalHash === syncedHash
        ? []
        : this.meta.pendingQueue.filter((item) => item.dbHash !== syncedHash);

    this.saveMetadata({
      ...this.meta,
      lastSyncedRevision: revision,
      lastSyncedHash: syncedHash,
      lastSyncedAt: syncedAtIso,
      lastSyncedSnapshot: clone(syncedDb),
      pendingQueue: remainingQueue,
      tombstones,
      conflicts,
    });
  }

  /**
   * Resolves a stored SyncConflict by applying the user's chosen version ('local' or 'remote')
   * and scheduling a sync to propagate the resolution cleanly.
   */
  public resolveConflict(conflictId: string, choice: 'local' | 'remote'): boolean {
    const target = this.meta.conflicts.find((c) => c.id === conflictId);
    if (!target) return false;

    const currentDb = this.getLocalDatabase();
    const resolvedDb = applyConflictResolution(currentDb, target, choice);
    const remainingConflicts = this.meta.conflicts.filter(
      (c) => c.id !== conflictId
    );

    this.saveMetadata({
      ...this.meta,
      conflicts: remainingConflicts,
    });

    this.applyRemoteDatabase(
      resolvedDb,
      `Conflitto risolto (${choice === 'local' ? 'versione locale' : 'versione remota'})`
    );

    this.notifyLocalChange(currentDb, resolvedDb, 'Risoluzione conflitto');
    return true;
  }

  public dispose(): void {
    this.disposed = true;
    this.clearDebounceTimer();
    this.listeners.clear();
  }
}
