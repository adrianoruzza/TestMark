import { AppDatabase } from '../types';
import { validateDatabase } from '../utils/storage';
import { GoogleDriveClient, GoogleDriveError, googleDrive } from './googleDrive';
import { canonicalDatabaseContent, computeSha256Hex } from './syncHash';
import { DriveBackupItem, DriveBackupPayload } from './syncTypes';

export const BACKUP_NAME_PREFIX = 'backup_TestMark_';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Generates the exact required backup filename format:
 * backup_TestMark_AAAA-MM-GG_HHMMSS.json
 */
export function formatBackupFileName(date = new Date(), uniqueSuffix?: string): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const base = `${BACKUP_NAME_PREFIX}${yyyy}-${mm}-${dd}_${hh}${min}${ss}`;
  return uniqueSuffix ? `${base}_${uniqueSuffix}.json` : `${base}.json`;
}

export function stripBackupExtension(name: string): string {
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

export interface RestoreBackupResult {
  restoredDatabase: AppDatabase;
  safetyBackup: DriveBackupItem;
  restoredFrom: DriveBackupItem;
}

/**
 * Autonomous Google Drive Manual Backup & Verified Restore service (Phase D).
 *
 * Guarantees:
 * - Saves manual backups EXCLUSIVELY inside SYNC_TestMark/BACKUP.
 * - Uses unique timestamped filenames (`backup_TestMark_AAAA-MM-GG_HHMMSS.json`).
 * - Never overwrites an existing backup file.
 * - Re-reads and verifies SHA-256 checksum after upload.
 * - Restore ALWAYS verifies target backup integrity AND creates a verified preventive
 *   safety backup of the current state before returning the restored database.
 */
export class DriveBackupService {
  private readonly drive: GoogleDriveClient;

  constructor(drive: GoogleDriveClient = googleDrive) {
    this.drive = drive;
  }

  /**
   * Lists manual backups stored exclusively inside SYNC_TestMark/BACKUP.
   */
  public async listBackups(): Promise<DriveBackupItem[]> {
    const files = await this.drive.listFilesInFolder('backup', {
      namePrefix: BACKUP_NAME_PREFIX,
      orderBy: 'createdTime desc',
      pageSize: 50,
    });

    return files
      .filter((f) => f.name.startsWith(BACKUP_NAME_PREFIX))
      .map((f) => ({
        fileId: f.id,
        name: f.name,
        createdTime: f.createdTime || f.modifiedTime || '',
        sizeBytes: Number(f.size || 0),
        classCount:
          f.appProperties?.classCount !== undefined
            ? Number(f.appProperties.classCount)
            : undefined,
        studentCount:
          f.appProperties?.studentCount !== undefined
            ? Number(f.appProperties.studentCount)
            : undefined,
        activityCount:
          f.appProperties?.activityCount !== undefined
            ? Number(f.appProperties.activityCount)
            : undefined,
        checksum: f.appProperties?.checksum,
      }));
  }

  /**
   * Creates a complete, immutable backup inside SYNC_TestMark/BACKUP and verifies it
   * by reading back the uploaded content and checking its SHA-256 checksum.
   */
  public async createBackup(
    db: AppDatabase,
    deviceId: string,
    options?: { date?: Date; suffix?: string }
  ): Promise<DriveBackupItem> {
    const folders = await this.drive.ensureAppFolders({ forceVerify: true });

    const now = options?.date ?? new Date();
    let fileName = formatBackupFileName(now, options?.suffix);

    // Guarantee uniqueness: never overwrite an existing backup even if triggered twice in 1 second
    const collision = await this.drive.findFileByName('backup', fileName);
    if (collision) {
      const msSuffix = String(now.getMilliseconds()).padStart(3, '0') + '_' + Math.random().toString(36).slice(2, 5);
      fileName = formatBackupFileName(now, options?.suffix ? `${options.suffix}_${msSuffix}` : msSuffix);
    }

    const canonical = canonicalDatabaseContent(db);
    const checksum = await computeSha256Hex(canonical);
    const classCount = db.classes.length;
    const studentCount = db.classes.reduce((sum, c) => sum + c.students.length, 0);
    const activityCount = db.classes.reduce((sum, c) => sum + c.activities.length, 0);

    const payload: DriveBackupPayload = {
      application: 'TestMark',
      backupFormatVersion: 2,
      backupName: stripBackupExtension(fileName),
      createdAt: now.toISOString(),
      deviceId,
      checksum,
      summary: {
        classCount,
        studentCount,
        activityCount,
      },
      database: db,
    };

    const jsonContent = JSON.stringify(payload, null, 2);
    const created = await this.drive.createJsonFileInFolder(
      'backup',
      fileName,
      jsonContent,
      {
        application: 'TestMark',
        kind: 'manual_backup',
        checksum,
        classCount: String(classCount),
        studentCount: String(studentCount),
        activityCount: String(activityCount),
      }
    );

    // Mandatory post-upload verification: re-verify parent folder + content checksum
    const verifiedMeta = await this.drive.getFileMetadata(created.id);
    if (
      verifiedMeta.trashed ||
      !Array.isArray(verifiedMeta.parents) ||
      !verifiedMeta.parents.includes(folders.backupFolderId)
    ) {
      throw new GoogleDriveError(
        'folder_mismatch',
        'Verifica post-caricamento fallita: il backup non risulta in SYNC_TestMark/BACKUP.'
      );
    }

    const downloadedText = await this.drive.downloadTextFile(created.id);
    await this.parseAndVerifyBackupText(downloadedText, checksum);

    return {
      fileId: created.id,
      name: created.name,
      createdTime: verifiedMeta.createdTime || now.toISOString(),
      sizeBytes: Number(verifiedMeta.size || jsonContent.length),
      classCount,
      studentCount,
      activityCount,
      checksum,
    };
  }

  /**
   * Downloads and cryptographically validates a backup file without mutating local data.
   */
  public async parseAndVerifyBackupText(
    rawText: string,
    expectedChecksum?: string
  ): Promise<{ payload: DriveBackupPayload; database: AppDatabase }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new GoogleDriveError(
        'invalid_response',
        'Il file di backup scaricato da Google Drive non è un JSON valido.'
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new GoogleDriveError(
        'invalid_response',
        'Struttura del backup Google Drive non valida.'
      );
    }

    const candidate = parsed as Partial<DriveBackupPayload> & {
      classes?: unknown;
    };

    // Support both structured TestMark v2 backup envelope and legacy raw AppDatabase JSON
    const rawDb = candidate.database ?? candidate;
    const validatedDb = validateDatabase(rawDb);
    if (!validatedDb) {
      throw new GoogleDriveError(
        'invalid_response',
        'I dati contenuti nel backup sono incompleti o danneggiati.'
      );
    }

    const actualChecksum = await computeSha256Hex(
      canonicalDatabaseContent(validatedDb)
    );

    if (candidate.checksum && candidate.checksum !== actualChecksum) {
      throw new GoogleDriveError(
        'invalid_response',
        'Verifica di integrità fallita: checksum del backup non corrispondente.'
      );
    }
    if (expectedChecksum && expectedChecksum !== actualChecksum) {
      throw new GoogleDriveError(
        'invalid_response',
        'Verifica post-caricamento fallita: il file salvato su Drive differisce dai dati locali.'
      );
    }

    const payload: DriveBackupPayload = {
      application: 'TestMark',
      backupFormatVersion: candidate.backupFormatVersion ?? 2,
      backupName: candidate.backupName ?? 'backup_TestMark',
      createdAt: candidate.createdAt ?? validatedDb.updatedAt,
      deviceId: candidate.deviceId ?? 'unknown',
      checksum: actualChecksum,
      summary: {
        classCount: validatedDb.classes.length,
        studentCount: validatedDb.classes.reduce(
          (sum, c) => sum + c.students.length,
          0
        ),
        activityCount: validatedDb.classes.reduce(
          (sum, c) => sum + c.activities.length,
          0
        ),
      },
      database: validatedDb,
    };

    return { payload, database: validatedDb };
  }

  /**
   * Downloads and verifies a backup from SYNC_TestMark/BACKUP for preview before confirmation.
   */
  public async inspectBackup(item: DriveBackupItem): Promise<DriveBackupPayload> {
    const rawText = await this.drive.downloadTextFile(item.fileId);
    const { payload } = await this.parseAndVerifyBackupText(
      rawText,
      item.checksum
    );
    return payload;
  }

  /**
   * Executes a verified restore:
   * 1. Downloads and validates target backup integrity BEFORE touching anything.
   * 2. Creates and verifies a preventive safety backup of the current local database in SYNC_TestMark/BACKUP.
   * 3. Returns the validated restored database for immediate local application.
   */
  public async restoreBackup(
    item: DriveBackupItem,
    currentDb: AppDatabase,
    deviceId: string
  ): Promise<RestoreBackupResult> {
    // Step 1: Verify the selected backup is 100% intact before doing anything else
    const rawText = await this.drive.downloadTextFile(item.fileId);
    const { database: restoredDatabase } = await this.parseAndVerifyBackupText(
      rawText,
      item.checksum
    );

    // Step 2: Mandatory preventive safety backup of current state before restore
    const safetyBackup = await this.createBackup(currentDb, deviceId, {
      suffix: 'pre_ripristino',
    });

    return {
      restoredDatabase,
      safetyBackup,
      restoredFrom: item,
    };
  }
}

export const driveBackupService = new DriveBackupService(googleDrive);
