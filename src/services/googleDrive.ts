import { GoogleAuthManager, googleAuth } from './googleAuth';
import { DriveFolderIds } from './syncTypes';

export const SYNC_ROOT_FOLDER_NAME = 'SYNC_TestMark';
export const BACKUP_SUBFOLDER_NAME = 'BACKUP';
export const SYNC_STATE_FILENAME = 'testmark_sync_state.json';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const FOLDER_VERIFY_TTL_MS = 2 * 60 * 1000; // Re-verify folder identity every 2 minutes or on explicit check

export type DriveErrorCode =
  | 'unauthenticated'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'not_found'
  | 'rate_limited'
  | 'network_error'
  | 'invalid_response'
  | 'folder_mismatch'
  | 'unknown';

export class GoogleDriveError extends Error {
  public readonly code: DriveErrorCode;
  public readonly status?: number;

  constructor(code: DriveErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'GoogleDriveError';
    this.code = code;
    this.status = status;
  }
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  appProperties?: Record<string, string>;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMultipartBody(
  metadata: Record<string, unknown>,
  content: string,
  contentMimeType = 'application/json'
): { body: string; boundary: string } {
  const boundary = `testmark_boundary_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const delimiter = `--${boundary}`;
  const closeDelimiter = `--${boundary}--`;
  const body =
    `${delimiter}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `${delimiter}\r\n` +
    `Content-Type: ${contentMimeType}; charset=UTF-8\r\n\r\n` +
    `${content}\r\n` +
    `${closeDelimiter}`;
  return { body, boundary };
}

/**
 * Autonomous Google Drive API v3 client (Phase B).
 *
 * Guarantees:
 * - Strictly operates inside SYNC_TestMark and SYNC_TestMark/BACKUP.
 * - Never writes any file into Google Drive root.
 * - Prevents duplicate folders/files via ordered lookup + single-flight lock.
 * - Verifies folder identity (name, mimeType, parent, not trashed) before writing.
 */
export class GoogleDriveClient {
  private readonly auth: GoogleAuthManager;
  private readonly fetchImpl: FetchLike;
  private cachedFolders: DriveFolderIds | null = null;
  private ensureFoldersPromise: Promise<DriveFolderIds> | null = null;

  constructor(auth: GoogleAuthManager = googleAuth, fetchImpl?: FetchLike) {
    this.auth = auth;
    this.fetchImpl =
      fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  public getCachedFolderIds(): DriveFolderIds | null {
    return this.cachedFolders ? { ...this.cachedFolders } : null;
  }

  public clearFolderCache(): void {
    this.cachedFolders = null;
  }

  private async authenticatedFetch(
    url: string,
    init: RequestInit = {},
    retryCount = 0,
    didAuthRetry = false
  ): Promise<Response> {
    const token = await this.auth.getValidAccessToken();
    if (!token) {
      throw new GoogleDriveError(
        'unauthenticated',
        'Sessione Google Drive non attiva. Effettua l’accesso per continuare.',
        401
      );
    }

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        cache: 'no-store',
      });
    } catch {
      if (retryCount < 1) {
        await sleep(500);
        return this.authenticatedFetch(url, init, retryCount + 1, didAuthRetry);
      }
      throw new GoogleDriveError(
        'network_error',
        'Errore di rete durante la comunicazione con Google Drive.'
      );
    }

    if (response.status === 401 && !didAuthRetry) {
      const refreshed = await this.auth.handleUnauthorizedResponse();
      if (refreshed) {
        return this.authenticatedFetch(url, init, retryCount, true);
      }
      throw new GoogleDriveError(
        'unauthenticated',
        'Autorizzazione Google Drive scaduta o revocata.',
        401
      );
    }

    if (response.status === 403) {
      const errorText = await response.text().catch(() => '');
      if (
        errorText.includes('storageQuotaExceeded') ||
        errorText.includes('quotaExceeded')
      ) {
        throw new GoogleDriveError(
          'quota_exceeded',
          'Spazio o quota di Google Drive esauriti.',
          403
        );
      }
      if (
        errorText.includes('rateLimitExceeded') ||
        errorText.includes('userRateLimitExceeded')
      ) {
        if (retryCount < 2) {
          await sleep(600 * (retryCount + 1));
          return this.authenticatedFetch(url, init, retryCount + 1, didAuthRetry);
        }
        throw new GoogleDriveError(
          'rate_limited',
          'Limite temporaneo di richieste Google Drive raggiunto. Riprova tra poco.',
          429
        );
      }
      if (!didAuthRetry) {
        const refreshed = await this.auth.handleUnauthorizedResponse();
        if (refreshed) {
          return this.authenticatedFetch(url, init, retryCount, true);
        }
      }
      throw new GoogleDriveError(
        'permission_denied',
        'Permessi Google Drive insufficienti o revocati.',
        403
      );
    }

    if (
      (response.status === 429 ||
        (response.status >= 500 && response.status <= 599)) &&
      retryCount < 2
    ) {
      await sleep(500 * Math.pow(2, retryCount));
      return this.authenticatedFetch(url, init, retryCount + 1, didAuthRetry);
    }

    if (response.status === 404) {
      throw new GoogleDriveError(
        'not_found',
        'Cartella o file non trovato su Google Drive.',
        404
      );
    }

    if (!response.ok) {
      throw new GoogleDriveError(
        'invalid_response',
        `Risposta inattesa da Google Drive (HTTP ${response.status}).`,
        response.status
      );
    }

    return response;
  }

  private async queryFiles(
    q: string,
    fields = 'files(id,name,mimeType,trashed,parents,createdTime,modifiedTime,size,appProperties)',
    orderBy = 'createdTime asc',
    pageSize = 20
  ): Promise<DriveFileMetadata[]> {
    const params = new URLSearchParams({
      q,
      fields,
      orderBy,
      pageSize: String(pageSize),
      spaces: 'drive',
    });
    const res = await this.authenticatedFetch(
      `${DRIVE_API_BASE}/files?${params.toString()}`,
      { method: 'GET' }
    );
    const data = (await res.json()) as { files?: DriveFileMetadata[] };
    if (!data || !Array.isArray(data.files)) {
      throw new GoogleDriveError(
        'invalid_response',
        'Risposta elenco file Google Drive non valida.'
      );
    }
    return data.files;
  }

  public async getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
    const params = new URLSearchParams({
      fields:
        'id,name,mimeType,trashed,parents,createdTime,modifiedTime,size,appProperties',
    });
    const res = await this.authenticatedFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      { method: 'GET' }
    );
    const meta = (await res.json()) as DriveFileMetadata;
    if (!meta || typeof meta.id !== 'string') {
      throw new GoogleDriveError(
        'invalid_response',
        'Metadati file Google Drive non validi.'
      );
    }
    return meta;
  }

  private async verifyFolderIdentity(
    folderId: string,
    expectedName: string,
    expectedParentId?: string
  ): Promise<boolean> {
    try {
      const meta = await this.getFileMetadata(folderId);
      if (meta.trashed) return false;
      if (meta.mimeType !== FOLDER_MIME_TYPE) return false;
      if (meta.name !== expectedName) return false;
      if (
        expectedParentId &&
        (!Array.isArray(meta.parents) || !meta.parents.includes(expectedParentId))
      ) {
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof GoogleDriveError && err.code === 'not_found') {
        return false;
      }
      throw err;
    }
  }

  private async findOrCreateFolder(
    folderName: string,
    parentId: string
  ): Promise<string> {
    const escapedName = escapeDriveQueryLiteral(folderName);
    const escapedParent = escapeDriveQueryLiteral(parentId);
    const query = `name = '${escapedName}' and mimeType = '${FOLDER_MIME_TYPE}' and '${escapedParent}' in parents and trashed = false`;

    const existing = await this.queryFiles(
      query,
      'files(id,name,mimeType,trashed,parents,createdTime)',
      'createdTime asc',
      10
    );

    if (existing.length > 0) {
      // Reuse the oldest canonical folder to prevent duplicates
      return existing[0].id;
    }

    const res = await this.authenticatedFetch(
      `${DRIVE_API_BASE}/files?fields=id,name,mimeType,parents,trashed`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          name: folderName,
          mimeType: FOLDER_MIME_TYPE,
          parents: [parentId],
        }),
      }
    );

    const created = (await res.json()) as DriveFileMetadata;
    if (!created?.id) {
      throw new GoogleDriveError(
        'invalid_response',
        `Impossibile creare la cartella ${folderName} su Google Drive.`
      );
    }
    return created.id;
  }

  /**
   * Ensures SYNC_TestMark and SYNC_TestMark/BACKUP exist without creating duplicates.
   * Uses a single-flight lock so concurrent calls share one resolution pass.
   */
  public async ensureAppFolders(options?: {
    forceVerify?: boolean;
  }): Promise<DriveFolderIds> {
    const ownerEmail = this.auth.getState().user?.email || '';

    if (
      this.cachedFolders &&
      this.cachedFolders.ownerEmail === ownerEmail &&
      !options?.forceVerify &&
      Date.now() - this.cachedFolders.verifiedAt < FOLDER_VERIFY_TTL_MS
    ) {
      return { ...this.cachedFolders };
    }

    if (this.ensureFoldersPromise) {
      return this.ensureFoldersPromise;
    }

    this.ensureFoldersPromise = (async () => {
      try {
        // Re-verify existing cached folder IDs first if belonging to the same user
        if (this.cachedFolders && this.cachedFolders.ownerEmail === ownerEmail) {
          const syncValid = await this.verifyFolderIdentity(
            this.cachedFolders.syncFolderId,
            SYNC_ROOT_FOLDER_NAME
          );
          const backupValid = syncValid
            ? await this.verifyFolderIdentity(
                this.cachedFolders.backupFolderId,
                BACKUP_SUBFOLDER_NAME,
                this.cachedFolders.syncFolderId
              )
            : false;

          if (syncValid && backupValid) {
            this.cachedFolders = {
              ...this.cachedFolders,
              verifiedAt: Date.now(),
            };
            return { ...this.cachedFolders };
          }
          this.cachedFolders = null;
        }

        const syncFolderId = await this.findOrCreateFolder(
          SYNC_ROOT_FOLDER_NAME,
          'root'
        );
        const backupFolderId = await this.findOrCreateFolder(
          BACKUP_SUBFOLDER_NAME,
          syncFolderId
        );

        // Verify identity right after resolution
        const verifiedSync = await this.verifyFolderIdentity(
          syncFolderId,
          SYNC_ROOT_FOLDER_NAME
        );
        const verifiedBackup = await this.verifyFolderIdentity(
          backupFolderId,
          BACKUP_SUBFOLDER_NAME,
          syncFolderId
        );
        if (!verifiedSync || !verifiedBackup) {
          throw new GoogleDriveError(
            'folder_mismatch',
            'Verifica dell’identità delle cartelle SYNC_TestMark/BACKUP non riuscita.'
          );
        }

        const resolved: DriveFolderIds = {
          syncFolderId,
          backupFolderId,
          verifiedAt: Date.now(),
          ownerEmail,
        };
        this.cachedFolders = resolved;
        return { ...resolved };
      } finally {
        this.ensureFoldersPromise = null;
      }
    })();

    return this.ensureFoldersPromise;
  }

  /**
   * Lists files strictly inside one of the verified TestMark folders.
   */
  public async listFilesInFolder(
    target: 'sync' | 'backup',
    options?: { namePrefix?: string; orderBy?: string; pageSize?: number }
  ): Promise<DriveFileMetadata[]> {
    const folders = await this.ensureAppFolders();
    const folderId =
      target === 'sync' ? folders.syncFolderId : folders.backupFolderId;

    const parts = [
      `'${escapeDriveQueryLiteral(folderId)}' in parents`,
      `mimeType != '${FOLDER_MIME_TYPE}'`,
      'trashed = false',
    ];
    if (options?.namePrefix) {
      parts.push(`name contains '${escapeDriveQueryLiteral(options.namePrefix)}'`);
    }

    return this.queryFiles(
      parts.join(' and '),
      'files(id,name,mimeType,trashed,parents,createdTime,modifiedTime,size,appProperties)',
      options?.orderBy ?? 'modifiedTime desc',
      options?.pageSize ?? 50
    );
  }

  /**
   * Finds a named JSON file strictly inside SYNC_TestMark or SYNC_TestMark/BACKUP.
   */
  public async findFileByName(
    target: 'sync' | 'backup',
    fileName: string
  ): Promise<DriveFileMetadata | null> {
    const folders = await this.ensureAppFolders();
    const folderId =
      target === 'sync' ? folders.syncFolderId : folders.backupFolderId;
    const query = `name = '${escapeDriveQueryLiteral(
      fileName
    )}' and '${escapeDriveQueryLiteral(folderId)}' in parents and trashed = false`;

    const files = await this.queryFiles(
      query,
      'files(id,name,mimeType,trashed,parents,createdTime,modifiedTime,size,appProperties)',
      'modifiedTime desc',
      5
    );
    return files[0] ?? null;
  }

  /**
   * Downloads raw JSON text of a Drive file by ID.
   */
  public async downloadTextFile(fileId: string): Promise<string> {
    const res = await this.authenticatedFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
      { method: 'GET' }
    );
    return res.text();
  }

  /**
   * Creates or atomically updates a named JSON file strictly inside SYNC_TestMark.
   * Re-verifies folder identity before writing and never creates duplicate files.
   */
  public async upsertJsonFileInSyncFolder(
    fileName: string,
    jsonContent: string,
    appProperties?: Record<string, string>
  ): Promise<DriveFileMetadata> {
    const folders = await this.ensureAppFolders({ forceVerify: true });
    const targetFolderId = folders.syncFolderId;
    if (!targetFolderId || targetFolderId === 'root') {
      throw new GoogleDriveError(
        'folder_mismatch',
        'Scrittura bloccata: cartella SYNC_TestMark non verificata.'
      );
    }

    const existing = await this.findFileByName('sync', fileName);

    if (existing) {
      // Atomic media + metadata update via multipart PATCH
      const { body, boundary } = buildMultipartBody(
        {
          name: fileName,
          mimeType: 'application/json',
          ...(appProperties ? { appProperties } : {}),
        },
        jsonContent,
        'application/json'
      );

      const res = await this.authenticatedFetch(
        `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(
          existing.id
        )}?uploadType=multipart&fields=id,name,mimeType,parents,modifiedTime,size,appProperties`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body,
        }
      );

      const updated = (await res.json()) as DriveFileMetadata;
      if (!updated?.id) {
        throw new GoogleDriveError(
          'invalid_response',
          'Conferma aggiornamento file su Google Drive mancante.'
        );
      }
      return updated;
    }

    return this.createJsonFileInFolder(
      'sync',
      fileName,
      jsonContent,
      appProperties
    );
  }

  /**
   * Creates a brand-new immutable JSON file strictly inside SYNC_TestMark or SYNC_TestMark/BACKUP.
   * Never overwrites existing files and strictly verifies parent folder identity before writing.
   */
  public async createJsonFileInFolder(
    target: 'sync' | 'backup',
    fileName: string,
    jsonContent: string,
    appProperties?: Record<string, string>
  ): Promise<DriveFileMetadata> {
    const folders = await this.ensureAppFolders({ forceVerify: true });
    const targetFolderId =
      target === 'sync' ? folders.syncFolderId : folders.backupFolderId;

    if (!targetFolderId || targetFolderId === 'root') {
      throw new GoogleDriveError(
        'folder_mismatch',
        'Scrittura bloccata: cartella di destinazione non valida.'
      );
    }

    const { body, boundary } = buildMultipartBody(
      {
        name: fileName,
        mimeType: 'application/json',
        parents: [targetFolderId],
        ...(appProperties ? { appProperties } : {}),
      },
      jsonContent,
      'application/json'
    );

    const res = await this.authenticatedFetch(
      `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,parents,createdTime,modifiedTime,size,appProperties`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );

    const created = (await res.json()) as DriveFileMetadata;
    if (
      !created?.id ||
      (Array.isArray(created.parents) && !created.parents.includes(targetFolderId))
    ) {
      throw new GoogleDriveError(
        'folder_mismatch',
        'File creato ma verifica della cartella di destinazione fallita.'
      );
    }
    return created;
  }
}

export const googleDrive = new GoogleDriveClient(googleAuth);
