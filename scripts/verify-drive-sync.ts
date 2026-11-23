import assert from 'node:assert/strict';
import { createSeedDatabase } from '../src/data/seedData';
import {
  DriveBackupService,
  BACKUP_NAME_PREFIX,
} from '../src/services/driveBackup';
import {
  AuthRuntimeAdapter,
  GoogleAuthManager,
} from '../src/services/googleAuth';
import {
  BACKUP_SUBFOLDER_NAME,
  FetchLike,
  GoogleDriveClient,
  GoogleDriveError,
  SYNC_ROOT_FOLDER_NAME,
  SYNC_STATE_FILENAME,
} from '../src/services/googleDrive';
import {
  StorageLike,
  TestMarkSyncEngine,
  formatSyncedStatusLabel,
  getSyncIndicatorText,
} from '../src/services/syncEngine';
import { GoogleUserProfile } from '../src/services/syncTypes';
import { AppDatabase } from '../src/types';

interface MockDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  createdTime: string;
  modifiedTime: string;
  content: string;
  appProperties: Record<string, string>;
}

/**
 * Faithful in-memory Google Drive v3 API server for autonomous testing of Phases B, C, D.
 */
class InMemoryDriveServer {
  public files = new Map<string, MockDriveFile>();
  public seq = 0;
  public uploadCount = 0;
  public validTokens = new Set<string>();
  public nextFailure: {
    status: number;
    body?: string;
    method?: string;
    networkError?: boolean;
  } | null = null;
  public corruptNextDownloadId: string | null = null;

  public resetFailures() {
    this.nextFailure = null;
    this.corruptNextDownloadId = null;
  }

  public getFilesByParent(parentId: string): MockDriveFile[] {
    return Array.from(this.files.values()).filter(
      (f) => !f.trashed && f.parents.includes(parentId)
    );
  }

  public getRootNonFolderFiles(): MockDriveFile[] {
    return Array.from(this.files.values()).filter(
      (f) =>
        !f.trashed &&
        f.parents.includes('root') &&
        f.mimeType !== 'application/vnd.google-apps.folder'
    );
  }

  private parseMultipart(body: string, contentType: string): {
    metadata: Record<string, unknown>;
    content: string;
  } {
    const match = contentType.match(/boundary=([^\s;]+)/);
    assert(match, 'Multipart boundary missing');
    const boundary = match[1];
    const parts = body
      .split(`--${boundary}`)
      .map((p) => p.trim())
      .filter((p) => p && p !== '--');
    assert(parts.length >= 2, 'Expected 2 multipart sections');
    const extractBody = (part: string) => {
      const idx = part.indexOf('\r\n\r\n');
      return idx >= 0 ? part.slice(idx + 4) : part;
    };
    return {
      metadata: JSON.parse(extractBody(parts[0])) as Record<string, unknown>,
      content: extractBody(parts[1]),
    };
  }

  private matchQuery(file: MockDriveFile, q: string): boolean {
    if (q.includes('trashed = false') && file.trashed) return false;

    const exactName = q.match(/name = '([^']+)'/);
    if (exactName && file.name !== exactName[1]) return false;

    const containsName = q.match(/name contains '([^']+)'/);
    if (containsName && !file.name.includes(containsName[1])) return false;

    const exactMime = q.match(/mimeType = '([^']+)'/);
    if (exactMime && file.mimeType !== exactMime[1]) return false;

    const neMime = q.match(/mimeType != '([^']+)'/);
    if (neMime && file.mimeType === neMime[1]) return false;

    const parentMatch = q.match(/'([^']+)' in parents/);
    if (parentMatch && !file.parents.includes(parentMatch[1])) return false;

    return true;
  }

  public createFetch(): FetchLike {
    return async (input, init = {}) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const url = new URL(urlStr);
      const method = (init.method || 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      const authHeader = headers.get('Authorization') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');

      if (this.nextFailure && (!this.nextFailure.method || this.nextFailure.method === method)) {
        const fail = this.nextFailure;
        this.nextFailure = null;
        if (fail.networkError) {
          throw new TypeError('Failed to fetch (simulated network interruption)');
        }
        return new Response(fail.body || 'error', { status: fail.status });
      }

      if (!this.validTokens.has(token)) {
        return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /drive/v3/about
      if (url.pathname.endsWith('/drive/v3/about')) {
        return new Response(
          JSON.stringify({ user: { emailAddress: 'docente@scuola.it' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // GET /drive/v3/files (list)
      if (method === 'GET' && url.pathname.endsWith('/drive/v3/files')) {
        const q = url.searchParams.get('q') || '';
        const orderBy = url.searchParams.get('orderBy') || 'createdTime asc';
        let list = Array.from(this.files.values()).filter((f) => this.matchQuery(f, q));
        if (orderBy.includes('createdTime desc')) {
          list.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
        } else if (orderBy.includes('modifiedTime desc')) {
          list.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
        } else {
          list.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
        }
        return new Response(
          JSON.stringify({
            files: list.map((f) => ({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              trashed: f.trashed,
              parents: f.parents,
              createdTime: f.createdTime,
              modifiedTime: f.modifiedTime,
              size: String(Buffer.byteLength(f.content, 'utf8')),
              appProperties: f.appProperties,
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // GET /drive/v3/files/:id
      const fileIdMatch = url.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
      if (method === 'GET' && fileIdMatch) {
        const id = decodeURIComponent(fileIdMatch[1]);
        const file = this.files.get(id);
        if (!file) {
          return new Response('Not found', { status: 404 });
        }
        if (url.searchParams.get('alt') === 'media') {
          if (this.corruptNextDownloadId === id) {
            this.corruptNextDownloadId = null;
            return new Response('{"corrupted": true, "database": null}', { status: 200 });
          }
          return new Response(file.content, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            trashed: file.trashed,
            parents: file.parents,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            size: String(Buffer.byteLength(file.content, 'utf8')),
            appProperties: file.appProperties,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // POST /drive/v3/files (create folder)
      if (method === 'POST' && url.pathname === '/drive/v3/files') {
        const meta = JSON.parse(String(init.body || '{}')) as {
          name: string;
          mimeType: string;
          parents?: string[];
        };
        const now = new Date(Date.now() + ++this.seq).toISOString();
        const id = `fld_${this.seq}`;
        const file: MockDriveFile = {
          id,
          name: meta.name,
          mimeType: meta.mimeType,
          parents: meta.parents || ['root'],
          trashed: false,
          createdTime: now,
          modifiedTime: now,
          content: '',
          appProperties: {},
        };
        this.files.set(id, file);
        return new Response(JSON.stringify(file), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /upload/drive/v3/files (multipart create file)
      if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
        this.uploadCount++;
        const { metadata, content } = this.parseMultipart(
          String(init.body || ''),
          headers.get('Content-Type') || ''
        );
        const now = new Date(Date.now() + ++this.seq).toISOString();
        const id = `file_${this.seq}`;
        const file: MockDriveFile = {
          id,
          name: String(metadata.name),
          mimeType: String(metadata.mimeType || 'application/json'),
          parents: Array.isArray(metadata.parents)
            ? (metadata.parents as string[])
            : ['root'],
          trashed: false,
          createdTime: now,
          modifiedTime: now,
          content,
          appProperties: (metadata.appProperties as Record<string, string>) || {},
        };
        this.files.set(id, file);
        return new Response(
          JSON.stringify({
            ...file,
            size: String(Buffer.byteLength(file.content, 'utf8')),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // PATCH /upload/drive/v3/files/:id (multipart update file)
      const patchMatch = url.pathname.match(/\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (method === 'PATCH' && patchMatch) {
        this.uploadCount++;
        const id = decodeURIComponent(patchMatch[1]);
        const existing = this.files.get(id);
        if (!existing) return new Response('Not found', { status: 404 });
        const { metadata, content } = this.parseMultipart(
          String(init.body || ''),
          headers.get('Content-Type') || ''
        );
        existing.content = content;
        existing.modifiedTime = new Date(Date.now() + ++this.seq).toISOString();
        if (metadata.appProperties) {
          existing.appProperties = metadata.appProperties as Record<string, string>;
        }
        return new Response(
          JSON.stringify({
            ...existing,
            size: String(Buffer.byteLength(existing.content, 'utf8')),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Unhandled route', { status: 400 });
    };
  }
}

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function createMockAuthAdapter(
  driveServer: InMemoryDriveServer,
  opts: {
    initialUser?: GoogleUserProfile | null;
    onlineRef?: { value: boolean };
    allowSilent?: { value: boolean };
    popupOmitsToken?: { value: boolean };
  } = {}
) {
  const onlineRef = opts.onlineRef ?? { value: true };
  const allowSilent = opts.allowSilent ?? { value: true };
  const popupOmitsToken = opts.popupOmitsToken ?? { value: false };
  let currentUser: GoogleUserProfile | null = opts.initialUser ?? null;
  let subscriber: ((u: GoogleUserProfile | null) => void) | null = null;
  let tokenSeq = 0;
  let silentCalls = 0;
  let popupCalls = 0;

  const mintToken = () => {
    const t = `tok_${++tokenSeq}`;
    driveServer.validTokens.add(t);
    return t;
  };

  const adapter: AuthRuntimeAdapter = {
    isOnline: () => onlineRef.value,
    subscribeAuthState: (cb) => {
      subscriber = cb;
      cb(currentUser);
      return () => {
        subscriber = null;
      };
    },
    popupSignIn: async () => {
      popupCalls++;
      currentUser = {
        uid: 'uid_teacher_1',
        email: 'docente@scuola.it',
        displayName: 'Prof. Test',
        photoURL: null,
      };
      const accessToken = popupOmitsToken.value ? null : mintToken();
      subscriber?.(currentUser);
      return { user: currentUser, accessToken };
    },
    requestGisToken: async ({ prompt }) => {
      if (prompt === '') {
        silentCalls++;
        if (!allowSilent.value) {
          throw new Error('interaction_required');
        }
      }
      return {
        accessToken: mintToken(),
        expiresInSec: 3600,
        grantedScope: 'https://www.googleapis.com/auth/drive.file',
      };
    },
    revokeGisToken: async (token) => {
      driveServer.validTokens.delete(token);
    },
    signOutProvider: async () => {
      currentUser = null;
      subscriber?.(null);
    },
    verifyDriveAccess: async (token) => {
      const ok = driveServer.validTokens.has(token);
      return { ok, status: ok ? 200 : 401, email: ok ? 'docente@scuola.it' : undefined };
    },
  };

  return {
    adapter,
    getCounts: () => ({ silentCalls, popupCalls }),
    onlineRef,
    allowSilent,
    popupOmitsToken,
    setCurrentUser: (u: GoogleUserProfile | null) => {
      currentUser = u;
      subscriber?.(u);
    },
  };
}

async function waitTick(ms = 25) {
  await new Promise((r) => setTimeout(r, ms));
}

async function runAllPhases() {
  console.log('=== FASE A: AUTENTICAZIONE GOOGLE ===');
  {
    const driveServer = new InMemoryDriveServer();
    const mock = createMockAuthAdapter(driveServer);
    const auth = new GoogleAuthManager(mock.adapter);
    auth.init();
    assert.equal(auth.getState().status, 'signed_out', 'A1: initial signed_out');

    // A1: First sign-in completes account selection + Drive verification
    const signedIn = await auth.signIn();
    assert.equal(signedIn.status, 'authenticated', 'A1: authenticated after signIn');
    assert.equal(signedIn.hasDriveAccess, true, 'A1: Drive access verified');
    assert.equal(signedIn.user?.email, 'docente@scuola.it');

    // A2: Valid cached token reused with ZERO additional silent or popup calls
    const beforeCounts = mock.getCounts();
    const tok1 = await auth.getValidAccessToken();
    const tok2 = await auth.getValidAccessToken();
    assert(tok1 && tok1 === tok2, 'A2: cached token reused');
    assert.equal(mock.getCounts().silentCalls, beforeCounts.silentCalls, 'A2: zero unnecessary silent renewals');
    assert.equal(mock.getCounts().popupCalls, beforeCounts.popupCalls, 'A2: zero extra popups');

    // A3: App close & reopen with persisted Firebase user -> silent GIS renewal without popup
    const reopenMock = createMockAuthAdapter(driveServer, {
      initialUser: signedIn.user,
    });
    const reopenedAuth = new GoogleAuthManager(reopenMock.adapter);
    reopenedAuth.init();
    await waitTick();
    assert.equal(reopenedAuth.getState().status, 'authenticated', 'A3: silently restored after reopen');
    assert.equal(reopenedAuth.getState().hasDriveAccess, true, 'A3: Drive access active after reopen');
    assert.equal(reopenMock.getCounts().popupCalls, 0, 'A3: zero login popups on reopen');
    assert.equal(reopenMock.getCounts().silentCalls, 1, 'A3: single silent GIS refresh on reopen');

    // A4: Permission revocation handled cleanly -> transitions to needs_reauth
    driveServer.validTokens.clear();
    reopenMock.allowSilent.value = false;
    const afterRevoke = await reopenedAuth.handleUnauthorizedResponse();
    assert.equal(afterRevoke, null, 'A4: revoked token returns null');
    assert.equal(reopenedAuth.getState().status, 'needs_reauth', 'A4: transitions cleanly to needs_reauth');
    assert.equal(reopenedAuth.getState().hasDriveAccess, false, 'A4: hasDriveAccess=false after revoke');

    // A5: Firebase popup without Drive token falls back to GIS consent inside same sign-in flow
    const fallbackMock = createMockAuthAdapter(driveServer, {
      popupOmitsToken: { value: true },
    });
    const fallbackAuth = new GoogleAuthManager(fallbackMock.adapter);
    fallbackAuth.init();
    const fallbackRes = await fallbackAuth.signIn();
    assert.equal(fallbackRes.status, 'authenticated', 'A5: fallback GIS consent completes login');
    assert.equal(fallbackRes.hasDriveAccess, true, 'A5: Drive access verified via GIS fallback');

    // A6: Offline reopen preserves offline_session and restores automatically when online
    const offlineMock = createMockAuthAdapter(driveServer, {
      initialUser: signedIn.user,
      onlineRef: { value: false },
    });
    const offlineAuth = new GoogleAuthManager(offlineMock.adapter);
    offlineAuth.init();
    await waitTick();
    assert.equal(offlineAuth.getState().status, 'offline_session', 'A6: offline_session preserved without error');
    offlineMock.onlineRef.value = true;
    const restoredOnline = await offlineAuth.handleNetworkRestored();
    assert.equal(restoredOnline, true, 'A6: restored Drive token when back online');
    assert.equal(offlineAuth.getState().status, 'authenticated', 'A6: authenticated after network restored');

    // A7: Sign-out clears token & state
    await offlineAuth.signOut({ revokeToken: true });
    assert.equal(offlineAuth.getState().status, 'signed_out', 'A7: signed_out cleanly');
    assert.equal(await offlineAuth.getValidAccessToken(), null, 'A7: no token after signOut');
    console.log('✓ FASE A superata (7/7 verifiche)');
  }

  console.log('=== FASE B: ACCESSO A GOOGLE DRIVE ===');
  {
    const driveServer = new InMemoryDriveServer();
    const mock = createMockAuthAdapter(driveServer);
    const auth = new GoogleAuthManager(mock.adapter);
    auth.init();
    await auth.signIn();
    const drive = new GoogleDriveClient(auth, driveServer.createFetch());

    // B1 + B2 + B3: Concurrent folder creation creates EXACTLY ONE SYNC_TestMark and ONE BACKUP
    const [f1, f2, f3] = await Promise.all([
      drive.ensureAppFolders(),
      drive.ensureAppFolders(),
      drive.ensureAppFolders(),
    ]);
    assert.equal(f1.syncFolderId, f2.syncFolderId, 'B3: single syncFolderId');
    assert.equal(f2.syncFolderId, f3.syncFolderId, 'B3: single syncFolderId across 3 calls');
    assert.equal(f1.backupFolderId, f3.backupFolderId, 'B3: single backupFolderId');

    const rootFolders = driveServer
      .getFilesByParent('root')
      .filter((f) => f.name === SYNC_ROOT_FOLDER_NAME);
    assert.equal(rootFolders.length, 1, 'B1: exactly one SYNC_TestMark folder');

    const backupFolders = driveServer
      .getFilesByParent(f1.syncFolderId)
      .filter((f) => f.name === BACKUP_SUBFOLDER_NAME);
    assert.equal(backupFolders.length, 1, 'B1: exactly one BACKUP subfolder inside SYNC_TestMark');

    // B4: Fresh client instance reuses existing folders (zero duplicates)
    const drive2 = new GoogleDriveClient(auth, driveServer.createFetch());
    const fReused = await drive2.ensureAppFolders();
    assert.equal(fReused.syncFolderId, f1.syncFolderId, 'B4: reuses existing SYNC_TestMark');
    assert.equal(fReused.backupFolderId, f1.backupFolderId, 'B4: reuses existing BACKUP');

    // B5: Multiple upserts update the SAME sync file without duplicates & zero files in root
    const up1 = await drive.upsertJsonFileInSyncFolder(SYNC_STATE_FILENAME, '{"v":1}');
    const up2 = await drive.upsertJsonFileInSyncFolder(SYNC_STATE_FILENAME, '{"v":2}');
    assert.equal(up1.id, up2.id, 'B5: updates same sync file ID');
    assert.equal(driveServer.getRootNonFolderFiles().length, 0, 'B2: zero files written in Drive root');

    // B6: Trashed folder detection & re-verification before write
    driveServer.files.get(f1.syncFolderId)!.trashed = true;
    const up3 = await drive.upsertJsonFileInSyncFolder(SYNC_STATE_FILENAME, '{"v":3}');
    assert.notEqual(up3.parents?.[0], f1.syncFolderId, 'B6: re-resolved trashed folder before write');

    // B7: HTTP 401 triggers transparent silent refresh + retry; HTTP 403 quota throws structured error
    driveServer.nextFailure = { status: 401 };
    const metaAfter401 = await drive.getFileMetadata(up3.id);
    assert.equal(metaAfter401.id, up3.id, 'B7: recovered seamlessly from 401');

    driveServer.nextFailure = { status: 403, body: 'storageQuotaExceeded' };
    await assert.rejects(
      () => drive.getFileMetadata(up3.id),
      (err: unknown) => err instanceof GoogleDriveError && err.code === 'quota_exceeded',
      'B7: classifies storageQuotaExceeded'
    );

    console.log('✓ FASE B superata (7/7 verifiche)');
  }

  console.log('=== FASE C: SINCRONIZZAZIONE MULTI-DISPOSITIVO E CONFLITTI ===');
  {
    const driveServer = new InMemoryDriveServer();
    const onlineA = { value: true };
    const onlineB = { value: true };

    const mockAuthA = createMockAuthAdapter(driveServer, { onlineRef: onlineA });
    const authA = new GoogleAuthManager(mockAuthA.adapter);
    authA.init();
    await authA.signIn();
    const driveA = new GoogleDriveClient(authA, driveServer.createFetch());

    const mockAuthB = createMockAuthAdapter(driveServer, { onlineRef: onlineB });
    const authB = new GoogleAuthManager(mockAuthB.adapter);
    authB.init();
    await authB.signIn();
    const driveB = new GoogleDriveClient(authB, driveServer.createFetch());

    let dbA: AppDatabase = createSeedDatabase();
    let dbB: AppDatabase = createSeedDatabase();

    const engineA = new TestMarkSyncEngine({
      auth: authA,
      drive: driveA,
      storage: createMemoryStorage(),
      isOnline: () => onlineA.value,
      debounceMs: 60,
      getLocalDatabase: () => dbA,
      applyRemoteDatabase: (next) => {
        dbA = next;
      },
    });

    const engineB = new TestMarkSyncEngine({
      auth: authB,
      drive: driveB,
      storage: createMemoryStorage(),
      isOnline: () => onlineB.value,
      debounceMs: 60,
      getLocalDatabase: () => dbB,
      applyRemoteDatabase: (next) => {
        dbB = next;
      },
    });

    // C1: Local edits debounced into a single upload
    const uploadsBefore = driveServer.uploadCount;
    for (let i = 0; i < 4; i++) {
      const prev = JSON.parse(JSON.stringify(dbA)) as AppDatabase;
      dbA.classes[0].name = `3A-Edit-${i}`;
      dbA.updatedAt = new Date(Date.now() + i * 10).toISOString();
      engineA.notifyLocalChange(prev, dbA, `Edit ${i}`);
    }
    assert.equal(engineA.getSnapshot().status, 'pending', 'C1: pending while debouncing');
    await waitTick(140);
    assert.equal(engineA.getSnapshot().status, 'synced', 'C1: synced after debounce');
    assert.equal(driveServer.uploadCount - uploadsBefore, 1, 'C1: 4 rapid edits batched into 1 upload');
    assert(
      getSyncIndicatorText(engineA.getSnapshot()).startsWith('Sincronizzato '),
      'C1: exact Italian synced format'
    );
    assert.match(
      formatSyncedStatusLabel(engineA.getSnapshot().lastSyncedAt!),
      /^Sincronizzato \d{2}\/\d{2}\/\d{4} ore \d{2}\.\d{2}$/,
      'C1: exact GG/MM/AAAA ore HH.MM format'
    );

    // C3: Noop when nothing changed
    const noopUploads = driveServer.uploadCount;
    const noopRes = await engineA.syncNow({ reason: 'manual' });
    assert.equal(noopRes.action, 'noop', 'C3: noop when identical');
    assert.equal(driveServer.uploadCount, noopUploads, 'C3: zero redundant uploads');

    // C4: New device B (untouched seed) pulls A's real data cleanly
    const pullRes = await engineB.syncNow({ reason: 'initial_new_device' });
    assert.equal(pullRes.ok, true, 'C4: new device sync succeeded');
    assert.equal(pullRes.action, 'pulled', 'C4: pulled cleanly');
    assert.equal(dbB.classes[0].name, '3A-Edit-3', 'C4: device B adopted device A state');

    // C5 + C6: Deletion propagation (A deletes an activity & a student -> B removes them)
    const prevDelA = JSON.parse(JSON.stringify(dbA)) as AppDatabase;
    const deletedActId = dbA.classes[0].activities[0].id;
    const deletedStuId = dbA.classes[0].students[0].id;
    dbA.classes[0].activities = dbA.classes[0].activities.filter((a) => a.id !== deletedActId);
    dbA.classes[0].students = dbA.classes[0].students.filter((s) => s.id !== deletedStuId);
    dbA.updatedAt = new Date(Date.now() + 1000).toISOString();
    engineA.notifyLocalChange(prevDelA, dbA, 'Elimina attività e studente');
    await engineA.syncNow({ reason: 'manual' });

    const bAfterDel = await engineB.syncNow({ reason: 'manual' });
    assert.equal(bAfterDel.ok, true, 'C6: B synced deletions');
    assert.equal(
      dbB.classes[0].activities.some((a) => a.id === deletedActId),
      false,
      'C6: deleted activity propagated without resurrection'
    );
    assert.equal(
      dbB.classes[0].students.some((s) => s.id === deletedStuId),
      false,
      'C6: deleted student propagated without resurrection'
    );

    // C7: Simultaneous NON-conflicting edits on different cells auto-merge with 0 conflicts
    const targetStu = dbA.classes[0].students[0];
    const act1 = dbA.classes[0].activities[0].id;
    const act2 = dbA.classes[0].activities[1].id;

    const prevMergeA = JSON.parse(JSON.stringify(dbA)) as AppDatabase;
    dbA.classes[0].students[0].records[act1] = 'SVOLTO';
    dbA.updatedAt = new Date(Date.now() + 2000).toISOString();
    engineA.notifyLocalChange(prevMergeA, dbA, 'A marks act1');

    const prevMergeB = JSON.parse(JSON.stringify(dbB)) as AppDatabase;
    dbB.classes[0].students[0].records[act2] = 'ASSENTE';
    dbB.updatedAt = new Date(Date.now() + 2100).toISOString();
    engineB.notifyLocalChange(prevMergeB, dbB, 'B marks act2');

    await engineA.syncNow({ reason: 'manual' });
    const mergeResB = await engineB.syncNow({ reason: 'manual' });
    assert.equal(mergeResB.conflictsDetected, 0, 'C7: zero conflicts on distinct cells');
    assert.equal(dbB.classes[0].students[0].records[act1], 'SVOLTO', 'C7: B kept A cell');
    assert.equal(dbB.classes[0].students[0].records[act2], 'ASSENTE', 'C7: B kept B cell');

    await engineA.syncNow({ reason: 'manual' });
    assert.equal(dbA.classes[0].students[0].records[act1], 'SVOLTO', 'C7: A has act1');
    assert.equal(dbA.classes[0].students[0].records[act2], 'ASSENTE', 'C7: A received act2');
    assert.equal(dbA.classes[0].students[0].id, targetStu.id);

    // C8: Simultaneous CONFLICTING edits on the EXACT SAME cell -> conflict detected, BOTH preserved
    const prevConfA = JSON.parse(JSON.stringify(dbA)) as AppDatabase;
    dbA.classes[0].students[0].records[act1] = 'NON_SVOLTO';
    dbA.updatedAt = new Date(Date.now() + 3000).toISOString();
    engineA.notifyLocalChange(prevConfA, dbA, 'A sets NON_SVOLTO');

    const prevConfB = JSON.parse(JSON.stringify(dbB)) as AppDatabase;
    dbB.classes[0].students[0].records[act1] = 'ASSENTE';
    dbB.updatedAt = new Date(Date.now() + 3500).toISOString();
    engineB.notifyLocalChange(prevConfB, dbB, 'B sets ASSENTE');

    await engineA.syncNow({ reason: 'manual' });
    const confResB = await engineB.syncNow({ reason: 'manual' });
    assert.equal(confResB.conflictsDetected, 1, 'C8: detected exact 1 cell conflict');
    const storedConflicts = engineB.getSnapshot().conflicts;
    assert.equal(storedConflicts.length, 1, 'C8: conflict stored for user review');
    assert.equal(storedConflicts[0].localSnapshot, 'ASSENTE', 'C8: local version preserved');
    assert.equal(storedConflicts[0].remoteSnapshot, 'NON_SVOLTO', 'C8: remote version preserved');

    // User resolves conflict choosing 'remote' (NON_SVOLTO)
    const resolved = engineB.resolveConflict(storedConflicts[0].id, 'remote');
    assert.equal(resolved, true, 'C8: conflict resolved');
    assert.equal(dbB.classes[0].students[0].records[act1], 'NON_SVOLTO', 'C8: applied user choice');
    assert.equal(engineB.getSnapshot().conflicts.length, 0, 'C8: conflict cleared after resolution');
    await engineB.syncNow({ reason: 'manual' });

    // C9: Offline editing + automatic resume on reconnect
    onlineA.value = false;
    engineA.handleConnectivityChange(false);
    assert.equal(engineA.getSnapshot().status, 'offline', 'C9: Offline indicator active');

    const prevOffA = JSON.parse(JSON.stringify(dbA)) as AppDatabase;
    dbA.classes[0].name = '3A-Offline-Edit';
    dbA.updatedAt = new Date(Date.now() + 4000).toISOString();
    engineA.notifyLocalChange(prevOffA, dbA, 'Edit offline');
    assert.equal(engineA.getSnapshot().status, 'offline', 'C9: stays offline while queueing');
    assert(engineA.getMetadata().pendingQueue.length > 0, 'C9: pending change persisted offline');

    onlineA.value = true;
    engineA.handleConnectivityChange(true);
    await waitTick(100);
    assert.equal(engineA.getSnapshot().status, 'synced', 'C9: resumed automatically on reconnect');

    // C10: Interrupted upload mid-flight recovers cleanly on retry (never falsely marks synced)
    const prevFailA = JSON.parse(JSON.stringify(dbA)) as AppDatabase;
    dbA.classes[0].name = '3A-Interrupted-Recovery';
    dbA.updatedAt = new Date(Date.now() + 5000).toISOString();
    engineA.notifyLocalChange(prevFailA, dbA, 'Interrupted test');
    driveServer.nextFailure = { status: 503, method: 'PATCH' };
    // Simulate persistent failure across retries by failing 3 times
    const originalFetch = driveServer.createFetch();
    let patchFailuresLeft = 3;
    const flakyDriveA = new GoogleDriveClient(authA, async (input, init) => {
      if ((init?.method || 'GET').toUpperCase() === 'PATCH' && patchFailuresLeft > 0) {
        patchFailuresLeft--;
        throw new TypeError('Simulated mid-upload drop');
      }
      return originalFetch(input, init);
    });
    const flakyEngine = new TestMarkSyncEngine({
      auth: authA,
      drive: flakyDriveA,
      storage: createMemoryStorage(),
      isOnline: () => true,
      debounceMs: 50,
      getLocalDatabase: () => dbA,
      applyRemoteDatabase: (next) => {
        dbA = next;
      },
    });
    const failedRun = await flakyEngine.syncNow({ reason: 'interrupted_test' });
    assert.equal(failedRun.ok, false, 'C10: interrupted upload reports failure');
    assert.equal(flakyEngine.getSnapshot().status, 'error', 'C10: status is error, NOT synced');

    const recoveredRun = await flakyEngine.syncNow({ reason: 'retry_after_drop' });
    assert.equal(recoveredRun.ok, true, 'C10: retry recovers completely');
    assert.equal(flakyEngine.getSnapshot().status, 'synced', 'C10: status synced only after Drive confirmation');

    engineA.dispose();
    engineB.dispose();
    flakyEngine.dispose();
    console.log('✓ FASE C superata (10/10 verifiche)');
  }

  console.log('=== FASE D: BACKUP MANUALI E RIPRISTINO VERIFICATO ===');
  {
    const driveServer = new InMemoryDriveServer();
    const mock = createMockAuthAdapter(driveServer);
    const auth = new GoogleAuthManager(mock.adapter);
    auth.init();
    await auth.signIn();
    const drive = new GoogleDriveClient(auth, driveServer.createFetch());
    const backupService = new DriveBackupService(drive);

    const dbV1 = createSeedDatabase();
    dbV1.classes[0].name = '3A-Originale';
    const fixedDate = new Date(2026, 10, 23, 14, 30, 5); // 2026-11-23 14:30:05

    // D1 + D2: Create multiple backups even at the EXACT same second -> zero overwrites
    const b1 = await backupService.createBackup(dbV1, 'dev_test', { date: fixedDate });
    const b2 = await backupService.createBackup(dbV1, 'dev_test', { date: fixedDate });
    assert.equal(b1.name, 'backup_TestMark_2026-11-23_143005.json', 'D1: exact backup filename format');
    assert.notEqual(b1.fileId, b2.fileId, 'D2: distinct file IDs');
    assert.notEqual(b1.name, b2.name, 'D2: unique name prevents overwrite in same second');
    assert.equal(driveServer.getRootNonFolderFiles().length, 0, 'D1: zero files in Drive root');

    // Confirm backups live strictly inside SYNC_TestMark/BACKUP
    const folders = await drive.ensureAppFolders();
    const filesInBackup = driveServer.getFilesByParent(folders.backupFolderId);
    assert.equal(filesInBackup.length, 2, 'D2: both backups stored inside SYNC_TestMark/BACKUP');

    // Also place a sync file in SYNC_TestMark and verify listBackups ignores it
    await drive.upsertJsonFileInSyncFolder(SYNC_STATE_FILENAME, '{"sync":true}');
    const listed = await backupService.listBackups();
    assert.equal(listed.length, 2, 'D4: listBackups lists only manual backups in BACKUP');
    assert(listed.every((b) => b.name.startsWith(BACKUP_NAME_PREFIX)));

    // D5: Modify current DB, then restore b1 -> verifies b1, creates preventive safety backup, recovers dbV1 completely
    const dbCurrent = createSeedDatabase();
    dbCurrent.classes = dbCurrent.classes.slice(0, 1);
    dbCurrent.classes[0].name = '3A-Modificata-Dopo';

    const restoreResult = await backupService.restoreBackup(b1, dbCurrent, 'dev_test');
    assert.equal(restoreResult.restoredDatabase.classes.length, dbV1.classes.length, 'D5: all classes restored');
    assert.equal(restoreResult.restoredDatabase.classes[0].name, '3A-Originale', 'D5: exact class state restored');
    assert(
      restoreResult.safetyBackup.name.includes('pre_ripristino'),
      'D5: preventive safety backup created before restore'
    );

    const listedAfterRestore = await backupService.listBackups();
    assert.equal(listedAfterRestore.length, 3, 'D5: safety backup preserved in SYNC_TestMark/BACKUP');

    // Verify safety backup actually holds dbCurrent!
    const safetyInspect = await backupService.inspectBackup(restoreResult.safetyBackup);
    assert.equal(safetyInspect.database.classes[0].name, '3A-Modificata-Dopo', 'D5: safety backup holds exact pre-restore state');

    // D6: Corrupted backup is rejected BEFORE creating safety backup or returning data
    driveServer.corruptNextDownloadId = b2.fileId;
    await assert.rejects(
      () => backupService.restoreBackup(b2, dbCurrent, 'dev_test'),
      (err: unknown) => err instanceof GoogleDriveError && err.code === 'invalid_response',
      'D6: corrupted backup rejected cleanly'
    );
    assert.equal((await backupService.listBackups()).length, 3, 'D6: no spurious safety backup created on failed validation');

    console.log('✓ FASE D superata (6/6 verifiche)');
  }

  console.log('\nTUTTE LE FASI AUTONOME (A, B, C, D) SUPERATE CON SUCCESSO.');
}

runAllPhases().catch((err) => {
  console.error('TEST FALLITO:', err);
  process.exit(1);
});
