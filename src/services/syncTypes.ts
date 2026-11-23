import { AppDatabase } from '../types';

export type AuthStatus =
  | 'initializing'
  | 'signed_out'
  | 'authenticating'
  | 'authenticated'
  | 'offline_session'
  | 'needs_reauth'
  | 'error';

export interface GoogleUserProfile {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
}

export interface AuthState {
  status: AuthStatus;
  user: GoogleUserProfile | null;
  hasDriveAccess: boolean;
  tokenExpiresAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export type SyncStatusCode =
  | 'idle'
  | 'synced'
  | 'syncing'
  | 'pending'
  | 'offline'
  | 'error';

export interface SyncTombstones {
  classes: Record<string, string>; // classId -> deletedAt ISO
  activities: Record<string, string>; // `${classId}:${activityId}` -> deletedAt ISO
  students: Record<string, string>; // `${classId}:${studentId}` -> deletedAt ISO
  archivedEntries: Record<string, string>; // `${classId}:${studentId}:${entryId}` -> deletedAt ISO
}

export interface SyncConflict {
  id: string;
  detectedAt: string;
  scope: 'class' | 'activity' | 'student' | 'cell';
  classId: string;
  className: string;
  entityId: string;
  entityLabel: string;
  description: string;
  localSummary: string;
  remoteSummary: string;
  localSnapshot: unknown;
  remoteSnapshot: unknown;
  chosenByDefault: 'local' | 'remote';
  /** Extra metadata for deterministic conflict resolution */
  meta?: {
    studentId?: string;
    activityId?: string;
    field?: string;
  };
}

export interface PendingSyncChange {
  id: string;
  timestamp: string;
  label: string;
  dbHash: string;
}

export interface LocalSyncMetadata {
  schemaVersion: number;
  deviceId: string;
  lastSyncedRevision: number;
  lastSyncedHash: string | null;
  lastSyncedAt: string | null;
  lastSyncedSnapshot: AppDatabase | null;
  pendingQueue: PendingSyncChange[];
  tombstones: SyncTombstones;
  conflicts: SyncConflict[];
}

export interface RemoteSyncPayload {
  application: 'TestMark';
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  updatedByDeviceId: string;
  checksum: string;
  tombstones: SyncTombstones;
  database: AppDatabase;
}

export interface DriveFolderIds {
  syncFolderId: string;
  backupFolderId: string;
  verifiedAt: number;
  ownerEmail: string;
}

export interface DriveBackupItem {
  fileId: string;
  name: string;
  createdTime: string;
  sizeBytes: number;
  classCount?: number;
  studentCount?: number;
  activityCount?: number;
  checksum?: string;
}

export interface DriveBackupPayload {
  application: 'TestMark';
  backupFormatVersion: number;
  backupName: string;
  createdAt: string;
  deviceId: string;
  checksum: string;
  summary: {
    classCount: number;
    studentCount: number;
    activityCount: number;
  };
  database: AppDatabase;
}

export interface SyncSnapshotState {
  status: SyncStatusCode;
  lastSyncedAt: string | null;
  pendingCount: number;
  lastError: string | null;
  conflicts: SyncConflict[];
  folderIds: {
    syncFolderId: string | null;
    backupFolderId: string | null;
  };
}

export function createEmptyTombstones(): SyncTombstones {
  return {
    classes: {},
    activities: {},
    students: {},
    archivedEntries: {},
  };
}
