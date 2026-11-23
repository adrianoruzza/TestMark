import {
  Activity,
  AppDatabase,
  ArchivedActivityEntry,
  CompletionStatus,
  STATUS_META,
  SchoolClass,
  Student,
  generateId,
} from '../types';
import { computeDatabaseHash, stableStringify } from './syncHash';
import {
  SyncConflict,
  SyncTombstones,
  createEmptyTombstones,
} from './syncTypes';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function maxIso(a?: string, b?: string): string {
  if (!a) return b || new Date().toISOString();
  if (!b) return a;
  return a >= b ? a : b;
}

export function mergeTombstones(
  local: SyncTombstones,
  remote: SyncTombstones
): SyncTombstones {
  const mergeMap = (
    m1: Record<string, string>,
    m2: Record<string, string>
  ): Record<string, string> => {
    const out: Record<string, string> = { ...m1 };
    for (const [key, ts] of Object.entries(m2)) {
      out[key] = out[key] ? maxIso(out[key], ts) : ts;
    }
    return out;
  };

  return {
    classes: mergeMap(local.classes || {}, remote.classes || {}),
    activities: mergeMap(local.activities || {}, remote.activities || {}),
    students: mergeMap(local.students || {}, remote.students || {}),
    archivedEntries: mergeMap(
      local.archivedEntries || {},
      remote.archivedEntries || {}
    ),
  };
}

/**
 * Tracks explicit entity deletions between prevDb and nextDb into tombstones,
 * and clears tombstones if an entity ID is later restored (e.g. via UNDO or backup restore).
 */
export function updateTombstonesFromDiff(
  prevDb: AppDatabase,
  nextDb: AppDatabase,
  existing: SyncTombstones,
  timestamp = new Date().toISOString()
): SyncTombstones {
  const next: SyncTombstones = {
    classes: { ...(existing.classes || {}) },
    activities: { ...(existing.activities || {}) },
    students: { ...(existing.students || {}) },
    archivedEntries: { ...(existing.archivedEntries || {}) },
  };

  const prevClasses = new Map(prevDb.classes.map((c) => [c.id, c]));
  const nextClasses = new Map(nextDb.classes.map((c) => [c.id, c]));

  // Detect deleted classes
  for (const [classId] of prevClasses) {
    if (!nextClasses.has(classId)) {
      next.classes[classId] = timestamp;
    }
  }

  // Clear resurrected classes and diff activities/students inside surviving classes
  for (const [classId, nextCls] of nextClasses) {
    if (next.classes[classId]) {
      delete next.classes[classId];
    }

    const prevCls = prevClasses.get(classId);
    if (!prevCls) continue;

    const prevActIds = new Set(prevCls.activities.map((a) => a.id));
    const nextActIds = new Set(nextCls.activities.map((a) => a.id));
    for (const actId of prevActIds) {
      if (!nextActIds.has(actId)) {
        next.activities[`${classId}:${actId}`] = timestamp;
      }
    }
    for (const actId of nextActIds) {
      delete next.activities[`${classId}:${actId}`];
    }

    const prevStudents = new Map(prevCls.students.map((s) => [s.id, s]));
    const nextStudents = new Map(nextCls.students.map((s) => [s.id, s]));
    for (const [stuId] of prevStudents) {
      if (!nextStudents.has(stuId)) {
        next.students[`${classId}:${stuId}`] = timestamp;
      }
    }
    for (const [stuId, nextStu] of nextStudents) {
      delete next.students[`${classId}:${stuId}`];
      const prevStu = prevStudents.get(stuId);
      if (!prevStu) continue;

      const prevEntries = new Set(prevStu.archivedHistory.map((e) => e.id));
      const nextEntries = new Set(nextStu.archivedHistory.map((e) => e.id));
      for (const entryId of prevEntries) {
        if (!nextEntries.has(entryId)) {
          next.archivedEntries[`${classId}:${stuId}:${entryId}`] = timestamp;
        }
      }
      for (const entryId of nextEntries) {
        delete next.archivedEntries[`${classId}:${stuId}:${entryId}`];
      }
    }
  }

  return next;
}

function classCoreSignature(cls: SchoolClass): string {
  return stableStringify({
    name: cls.name,
    schoolYear: cls.schoolYear,
    minimums: cls.minimums,
    includeArchivedInCount: cls.includeArchivedInCount,
  });
}

function activitySignature(a: Activity): string {
  return stableStringify({
    title: a.title,
    category: a.category,
    date: a.date,
    notes: a.notes ?? '',
  });
}

function studentProfileSignature(s: Student): string {
  return stableStringify({
    lastName: s.lastName,
    firstName: s.firstName,
    notes: s.notes ?? '',
  });
}

function fullClassSignature(cls: SchoolClass): string {
  return stableStringify({
    core: classCoreSignature(cls),
    activities: [...cls.activities].sort((a, b) => a.id.localeCompare(b.id)),
    students: [...cls.students]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => ({
        ...s,
        archivedHistory: [...s.archivedHistory].sort((a, b) =>
          a.id.localeCompare(b.id)
        ),
      })),
  });
}

function fullStudentSignature(s: Student): string {
  return stableStringify({
    profile: studentProfileSignature(s),
    records: s.records,
    archivedHistory: [...s.archivedHistory].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
  });
}

export interface ThreeWayMergeInput {
  base: AppDatabase | null;
  local: AppDatabase;
  remote: AppDatabase;
  localTombstones: SyncTombstones;
  remoteTombstones: SyncTombstones;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  isLocalUntouchedSeed: boolean;
}

export interface ThreeWayMergeResult {
  merged: AppDatabase;
  tombstones: SyncTombstones;
  conflicts: SyncConflict[];
  changedLocally: boolean;
  shouldPushRemote: boolean;
}

/**
 * Deterministic 3-way multi-device merge engine (Phase C).
 *
 * - Merges independently per class, activity, student, archived entry, and cell status.
 * - Propagates explicit deletions via tombstones without resurrecting deleted items.
 * - Detects true concurrent conflicting edits on the same item/cell and preserves BOTH
 *   versions in `conflicts` (zero silent data loss).
 */
export function mergeDatabasesThreeWay(
  input: ThreeWayMergeInput
): ThreeWayMergeResult {
  const {
    base,
    local,
    remote,
    localTombstones,
    remoteTombstones,
    localUpdatedAt,
    remoteUpdatedAt,
    isLocalUntouchedSeed,
  } = input;

  const combinedTombstones = mergeTombstones(localTombstones, remoteTombstones);
  const localHash = computeDatabaseHash(local);
  const remoteHash = computeDatabaseHash(remote);
  const baseHash = base ? computeDatabaseHash(base) : null;

  // 1. Identical content on both devices
  if (localHash === remoteHash) {
    return {
      merged: clone(local),
      tombstones: combinedTombstones,
      conflicts: [],
      changedLocally: false,
      shouldPushRemote: false,
    };
  }

  // 2. First sync on a brand-new device that still only has default seed data
  if (!base && isLocalUntouchedSeed) {
    const adopted = clone(remote);
    adopted.activeClassId =
      adopted.activeClassId &&
      adopted.classes.some((c) => c.id === adopted.activeClassId)
        ? adopted.activeClassId
        : adopted.classes[0]?.id ?? null;
    return {
      merged: adopted,
      tombstones: combinedTombstones,
      conflicts: [],
      changedLocally: true,
      shouldPushRemote: false,
    };
  }

  // 3. Fast-forward pull (only remote changed since base)
  if (baseHash && localHash === baseHash && remoteHash !== baseHash) {
    const pulled = clone(remote);
    pulled.activeClassId =
      local.activeClassId &&
      pulled.classes.some((c) => c.id === local.activeClassId)
        ? local.activeClassId
        : pulled.classes[0]?.id ?? null;
    return {
      merged: pulled,
      tombstones: combinedTombstones,
      conflicts: [],
      changedLocally: true,
      shouldPushRemote: false,
    };
  }

  // 4. Fast-forward push (only local changed since base)
  if (baseHash && remoteHash === baseHash && localHash !== baseHash) {
    return {
      merged: clone(local),
      tombstones: combinedTombstones,
      conflicts: [],
      changedLocally: false,
      shouldPushRemote: true,
    };
  }

  // 5. Concurrent changes on both devices (or independent initial merge): 3-way granular merge
  const preferLocalByTime = localUpdatedAt >= remoteUpdatedAt;
  const nowIso = new Date().toISOString();
  const conflicts: SyncConflict[] = [];

  const baseClassMap = new Map((base?.classes ?? []).map((c) => [c.id, c]));
  const localClassMap = new Map(local.classes.map((c) => [c.id, c]));
  const remoteClassMap = new Map(remote.classes.map((c) => [c.id, c]));

  const orderedClassIds: string[] = [];
  const seenClassIds = new Set<string>();
  for (const list of [local.classes, remote.classes]) {
    for (const c of list) {
      if (!seenClassIds.has(c.id)) {
        seenClassIds.add(c.id);
        orderedClassIds.push(c.id);
      }
    }
  }

  const mergedClasses: SchoolClass[] = [];

  for (const classId of orderedClassIds) {
    const baseCls = baseClassMap.get(classId);
    const localCls = localClassMap.get(classId);
    const remoteCls = remoteClassMap.get(classId);

    // Exists only locally
    if (localCls && !remoteCls) {
      const deletedRemotelyAt = remoteTombstones.classes?.[classId];
      if (baseCls || deletedRemotelyAt) {
        const localModified =
          !baseCls || fullClassSignature(localCls) !== fullClassSignature(baseCls);
        if (!localModified) {
          // Remote deleted an untouched class -> honor deletion
          continue;
        }
        // Remote deleted, but local modified -> preserve local & report conflict
        conflicts.push({
          id: generateId('conf'),
          detectedAt: nowIso,
          scope: 'class',
          classId,
          className: localCls.name,
          entityId: classId,
          entityLabel: `Classe ${localCls.name}`,
          description:
            'Classe eliminata su un altro dispositivo ma modificata localmente. Conservata la versione locale.',
          localSummary: `Mantenuta (${localCls.students.length} studenti, ${localCls.activities.length} attività)`,
          remoteSummary: 'Eliminata sull’altro dispositivo',
          localSnapshot: clone(localCls),
          remoteSnapshot: null,
          chosenByDefault: 'local',
        });
        delete combinedTombstones.classes[classId];
        mergedClasses.push(clone(localCls));
      } else {
        // Brand-new local class
        mergedClasses.push(clone(localCls));
      }
      continue;
    }

    // Exists only remotely
    if (!localCls && remoteCls) {
      const deletedLocallyAt = localTombstones.classes?.[classId];
      if (baseCls || deletedLocallyAt) {
        const remoteModified =
          !baseCls || fullClassSignature(remoteCls) !== fullClassSignature(baseCls);
        if (!remoteModified) {
          // Local deleted an untouched class -> honor deletion
          continue;
        }
        // Local deleted, but remote modified -> preserve remote & report conflict
        conflicts.push({
          id: generateId('conf'),
          detectedAt: nowIso,
          scope: 'class',
          classId,
          className: remoteCls.name,
          entityId: classId,
          entityLabel: `Classe ${remoteCls.name}`,
          description:
            'Classe eliminata localmente ma modificata su un altro dispositivo. Conservata la versione remota.',
          localSummary: 'Eliminata localmente',
          remoteSummary: `Mantenuta (${remoteCls.students.length} studenti, ${remoteCls.activities.length} attività)`,
          localSnapshot: null,
          remoteSnapshot: clone(remoteCls),
          chosenByDefault: 'remote',
        });
        delete combinedTombstones.classes[classId];
        mergedClasses.push(clone(remoteCls));
      } else {
        // Brand-new remote class
        mergedClasses.push(clone(remoteCls));
      }
      continue;
    }

    if (!localCls || !remoteCls) continue;

    // Class exists on BOTH devices -> merge metadata, activities, students
    const baseCore = baseCls ? classCoreSignature(baseCls) : null;
    const localCore = classCoreSignature(localCls);
    const remoteCore = classCoreSignature(remoteCls);

    let chosenMetaSource: SchoolClass = localCls;
    if (localCore !== remoteCore) {
      if (baseCore && localCore === baseCore) {
        chosenMetaSource = remoteCls;
      } else if (baseCore && remoteCore === baseCore) {
        chosenMetaSource = localCls;
      } else {
        chosenMetaSource = preferLocalByTime ? localCls : remoteCls;
        conflicts.push({
          id: generateId('conf'),
          detectedAt: nowIso,
          scope: 'class',
          classId,
          className: chosenMetaSource.name,
          entityId: classId,
          entityLabel: `Impostazioni classe ${chosenMetaSource.name}`,
          description:
            'Impostazioni o minimi della classe modificati contemporaneamente su due dispositivi.',
          localSummary: `${localCls.name} (${localCls.schoolYear}) — Minimi ${localCls.minimums.COMPITO_GRAFICO}/${localCls.minimums.INTERROGAZIONE_ORALE}/${localCls.minimums.CONSEGNA_PRATICO}`,
          remoteSummary: `${remoteCls.name} (${remoteCls.schoolYear}) — Minimi ${remoteCls.minimums.COMPITO_GRAFICO}/${remoteCls.minimums.INTERROGAZIONE_ORALE}/${remoteCls.minimums.CONSEGNA_PRATICO}`,
          localSnapshot: {
            name: localCls.name,
            schoolYear: localCls.schoolYear,
            minimums: clone(localCls.minimums),
            includeArchivedInCount: localCls.includeArchivedInCount,
          },
          remoteSnapshot: {
            name: remoteCls.name,
            schoolYear: remoteCls.schoolYear,
            minimums: clone(remoteCls.minimums),
            includeArchivedInCount: remoteCls.includeArchivedInCount,
          },
          chosenByDefault: preferLocalByTime ? 'local' : 'remote',
          meta: { field: 'class_settings' },
        });
      }
    }

    // Merge activities inside this class
    const baseActMap = new Map((baseCls?.activities ?? []).map((a) => [a.id, a]));
    const localActMap = new Map(localCls.activities.map((a) => [a.id, a]));
    const remoteActMap = new Map(remoteCls.activities.map((a) => [a.id, a]));
    const actIds = Array.from(
      new Set([...localActMap.keys(), ...remoteActMap.keys()])
    );
    const mergedActivities: Activity[] = [];

    for (const actId of actIds) {
      const baseAct = baseActMap.get(actId);
      const localAct = localActMap.get(actId);
      const remoteAct = remoteActMap.get(actId);
      const tombKey = `${classId}:${actId}`;

      if (localAct && !remoteAct) {
        if (baseAct || remoteTombstones.activities?.[tombKey]) {
          const localChanged =
            !baseAct || activitySignature(localAct) !== activitySignature(baseAct);
          if (!localChanged) continue;
          conflicts.push({
            id: generateId('conf'),
            detectedAt: nowIso,
            scope: 'activity',
            classId,
            className: chosenMetaSource.name,
            entityId: actId,
            entityLabel: `Attività "${localAct.title}"`,
            description:
              'Attività eliminata su un altro dispositivo ma modificata localmente. Conservata la versione locale.',
            localSummary: `${localAct.title} (${localAct.date})`,
            remoteSummary: 'Eliminata sull’altro dispositivo',
            localSnapshot: clone(localAct),
            remoteSnapshot: null,
            chosenByDefault: 'local',
            meta: { activityId: actId },
          });
          delete combinedTombstones.activities[tombKey];
          mergedActivities.push(clone(localAct));
        } else {
          mergedActivities.push(clone(localAct));
        }
        continue;
      }

      if (!localAct && remoteAct) {
        if (baseAct || localTombstones.activities?.[tombKey]) {
          const remoteChanged =
            !baseAct || activitySignature(remoteAct) !== activitySignature(baseAct);
          if (!remoteChanged) continue;
          conflicts.push({
            id: generateId('conf'),
            detectedAt: nowIso,
            scope: 'activity',
            classId,
            className: chosenMetaSource.name,
            entityId: actId,
            entityLabel: `Attività "${remoteAct.title}"`,
            description:
              'Attività eliminata localmente ma modificata su un altro dispositivo. Conservata la versione remota.',
            localSummary: 'Eliminata localmente',
            remoteSummary: `${remoteAct.title} (${remoteAct.date})`,
            localSnapshot: null,
            remoteSnapshot: clone(remoteAct),
            chosenByDefault: 'remote',
            meta: { activityId: actId },
          });
          delete combinedTombstones.activities[tombKey];
          mergedActivities.push(clone(remoteAct));
        } else {
          mergedActivities.push(clone(remoteAct));
        }
        continue;
      }

      if (!localAct || !remoteAct) continue;

      const baseSig = baseAct ? activitySignature(baseAct) : null;
      const localSig = activitySignature(localAct);
      const remoteSig = activitySignature(remoteAct);

      if (localSig === remoteSig) {
        mergedActivities.push(clone(localAct));
      } else if (baseSig && localSig === baseSig) {
        mergedActivities.push(clone(remoteAct));
      } else if (baseSig && remoteSig === baseSig) {
        mergedActivities.push(clone(localAct));
      } else {
        const chosen = preferLocalByTime ? localAct : remoteAct;
        conflicts.push({
          id: generateId('conf'),
          detectedAt: nowIso,
          scope: 'activity',
          classId,
          className: chosenMetaSource.name,
          entityId: actId,
          entityLabel: `Attività "${chosen.title}"`,
          description:
            'Dettagli attività modificati contemporaneamente su due dispositivi.',
          localSummary: `${localAct.title} (${localAct.date})`,
          remoteSummary: `${remoteAct.title} (${remoteAct.date})`,
          localSnapshot: clone(localAct),
          remoteSnapshot: clone(remoteAct),
          chosenByDefault: preferLocalByTime ? 'local' : 'remote',
          meta: { activityId: actId },
        });
        mergedActivities.push(clone(chosen));
      }
    }

    const validActivityIds = new Set(mergedActivities.map((a) => a.id));
    const activityTitleMap = new Map(mergedActivities.map((a) => [a.id, a.title]));

    // Merge students inside this class (including independent per-cell merge!)
    const baseStuMap = new Map((baseCls?.students ?? []).map((s) => [s.id, s]));
    const localStuMap = new Map(localCls.students.map((s) => [s.id, s]));
    const remoteStuMap = new Map(remoteCls.students.map((s) => [s.id, s]));
    const stuIds = Array.from(
      new Set([...localStuMap.keys(), ...remoteStuMap.keys()])
    );
    const mergedStudents: Student[] = [];

    for (const stuId of stuIds) {
      const baseStu = baseStuMap.get(stuId);
      const localStu = localStuMap.get(stuId);
      const remoteStu = remoteStuMap.get(stuId);
      const tombKey = `${classId}:${stuId}`;

      if (localStu && !remoteStu) {
        if (baseStu || remoteTombstones.students?.[tombKey]) {
          const localChanged =
            !baseStu || fullStudentSignature(localStu) !== fullStudentSignature(baseStu);
          if (!localChanged) continue;
          conflicts.push({
            id: generateId('conf'),
            detectedAt: nowIso,
            scope: 'student',
            classId,
            className: chosenMetaSource.name,
            entityId: stuId,
            entityLabel: `${localStu.lastName} ${localStu.firstName}`,
            description:
              'Studente eliminato su un altro dispositivo ma modificato localmente. Conservato lo studente locale.',
            localSummary: `${localStu.lastName} ${localStu.firstName} (presente)`,
            remoteSummary: 'Eliminato sull’altro dispositivo',
            localSnapshot: clone(localStu),
            remoteSnapshot: null,
            chosenByDefault: 'local',
            meta: { studentId: stuId },
          });
          delete combinedTombstones.students[tombKey];
          mergedStudents.push(clone(localStu));
        } else {
          mergedStudents.push(clone(localStu));
        }
        continue;
      }

      if (!localStu && remoteStu) {
        if (baseStu || localTombstones.students?.[tombKey]) {
          const remoteChanged =
            !baseStu ||
            fullStudentSignature(remoteStu) !== fullStudentSignature(baseStu);
          if (!remoteChanged) continue;
          conflicts.push({
            id: generateId('conf'),
            detectedAt: nowIso,
            scope: 'student',
            classId,
            className: chosenMetaSource.name,
            entityId: stuId,
            entityLabel: `${remoteStu.lastName} ${remoteStu.firstName}`,
            description:
              'Studente eliminato localmente ma modificato su un altro dispositivo. Conservato lo studente remoto.',
            localSummary: 'Eliminato localmente',
            remoteSummary: `${remoteStu.lastName} ${remoteStu.firstName} (presente)`,
            localSnapshot: null,
            remoteSnapshot: clone(remoteStu),
            chosenByDefault: 'remote',
            meta: { studentId: stuId },
          });
          delete combinedTombstones.students[tombKey];
          mergedStudents.push(clone(remoteStu));
        } else {
          mergedStudents.push(clone(remoteStu));
        }
        continue;
      }

      if (!localStu || !remoteStu) continue;

      // Merge student profile fields
      const baseProf = baseStu ? studentProfileSignature(baseStu) : null;
      const localProf = studentProfileSignature(localStu);
      const remoteProf = studentProfileSignature(remoteStu);
      let profSource = localStu;
      if (localProf !== remoteProf) {
        if (baseProf && localProf === baseProf) {
          profSource = remoteStu;
        } else if (baseProf && remoteProf === baseProf) {
          profSource = localStu;
        } else {
          profSource = preferLocalByTime ? localStu : remoteStu;
          conflicts.push({
            id: generateId('conf'),
            detectedAt: nowIso,
            scope: 'student',
            classId,
            className: chosenMetaSource.name,
            entityId: stuId,
            entityLabel: `${profSource.lastName} ${profSource.firstName}`,
            description:
              'Dati anagrafici o note dello studente modificati contemporaneamente su due dispositivi.',
            localSummary: `${localStu.lastName} ${localStu.firstName}${localStu.notes ? ` (${localStu.notes})` : ''}`,
            remoteSummary: `${remoteStu.lastName} ${remoteStu.firstName}${remoteStu.notes ? ` (${remoteStu.notes})` : ''}`,
            localSnapshot: {
              lastName: localStu.lastName,
              firstName: localStu.firstName,
              notes: localStu.notes,
            },
            remoteSnapshot: {
              lastName: remoteStu.lastName,
              firstName: remoteStu.firstName,
              notes: remoteStu.notes,
            },
            chosenByDefault: preferLocalByTime ? 'local' : 'remote',
            meta: { studentId: stuId, field: 'student_profile' },
          });
        }
      }

      // Independent cell-by-cell merge for student.records
      const mergedRecords: Record<string, CompletionStatus> = {};
      const recordActIds = new Set([
        ...Object.keys(localStu.records || {}),
        ...Object.keys(remoteStu.records || {}),
      ]);

      for (const actId of recordActIds) {
        if (!validActivityIds.has(actId)) continue;
        const baseVal: CompletionStatus = baseStu?.records?.[actId] ?? 'PENDENTE';
        const localVal: CompletionStatus = localStu.records?.[actId] ?? 'PENDENTE';
        const remoteVal: CompletionStatus = remoteStu.records?.[actId] ?? 'PENDENTE';

        let chosenVal: CompletionStatus;
        if (localVal === remoteVal) {
          chosenVal = localVal;
        } else if (baseStu && localVal === baseVal) {
          chosenVal = remoteVal;
        } else if (baseStu && remoteVal === baseVal) {
          chosenVal = localVal;
        } else if (!baseStu && localVal === 'PENDENTE') {
          chosenVal = remoteVal;
        } else if (!baseStu && remoteVal === 'PENDENTE') {
          chosenVal = localVal;
        } else {
          chosenVal = preferLocalByTime ? localVal : remoteVal;
          const actLabel = activityTitleMap.get(actId) || actId;
          conflicts.push({
            id: generateId('conf'),
            detectedAt: nowIso,
            scope: 'cell',
            classId,
            className: chosenMetaSource.name,
            entityId: `${stuId}:${actId}`,
            entityLabel: `${profSource.lastName} ${profSource.firstName} — ${actLabel}`,
            description:
              'Stato della prova modificato contemporaneamente su due dispositivi con valori diversi.',
            localSummary: STATUS_META[localVal].label,
            remoteSummary: STATUS_META[remoteVal].label,
            localSnapshot: localVal,
            remoteSnapshot: remoteVal,
            chosenByDefault: preferLocalByTime ? 'local' : 'remote',
            meta: { studentId: stuId, activityId: actId },
          });
        }

        if (chosenVal !== 'PENDENTE') {
          mergedRecords[actId] = chosenVal;
        }
      }

      // Union merge of archivedHistory respecting tombstones
      const archivedMap = new Map<string, ArchivedActivityEntry>();
      for (const entry of remoteStu.archivedHistory || []) {
        const key = `${classId}:${stuId}:${entry.id}`;
        if (!localTombstones.archivedEntries?.[key]) {
          archivedMap.set(entry.id, clone(entry));
        }
      }
      for (const entry of localStu.archivedHistory || []) {
        const key = `${classId}:${stuId}:${entry.id}`;
        if (!remoteTombstones.archivedEntries?.[key]) {
          archivedMap.set(entry.id, clone(entry));
        }
      }

      mergedStudents.push({
        id: stuId,
        lastName: profSource.lastName,
        firstName: profSource.firstName,
        notes: profSource.notes,
        records: mergedRecords,
        archivedHistory: Array.from(archivedMap.values()),
        createdAt: localStu.createdAt || remoteStu.createdAt,
      });
    }

    mergedClasses.push({
      id: classId,
      name: chosenMetaSource.name,
      schoolYear: chosenMetaSource.schoolYear,
      minimums: clone(chosenMetaSource.minimums),
      includeArchivedInCount: chosenMetaSource.includeArchivedInCount,
      activities: mergedActivities,
      students: mergedStudents,
      createdAt: localCls.createdAt || remoteCls.createdAt,
    });
  }

  const activeClassId =
    local.activeClassId && mergedClasses.some((c) => c.id === local.activeClassId)
      ? local.activeClassId
      : remote.activeClassId &&
          mergedClasses.some((c) => c.id === remote.activeClassId)
        ? remote.activeClassId
        : mergedClasses[0]?.id ?? null;

  const merged: AppDatabase = {
    version: 1,
    updatedAt: maxIso(localUpdatedAt, remoteUpdatedAt),
    activeClassId,
    classes: mergedClasses,
  };

  const mergedHash = computeDatabaseHash(merged);

  return {
    merged,
    tombstones: combinedTombstones,
    conflicts,
    changedLocally: mergedHash !== localHash,
    shouldPushRemote: mergedHash !== remoteHash,
  };
}

/**
 * Applies an explicit user decision ('local' or 'remote') for a detected SyncConflict.
 */
export function applyConflictResolution(
  db: AppDatabase,
  conflict: SyncConflict,
  choice: 'local' | 'remote'
): AppDatabase {
  const chosen = choice === 'local' ? conflict.localSnapshot : conflict.remoteSnapshot;

  if (conflict.scope === 'class') {
    if (conflict.meta?.field === 'class_settings' && chosen && typeof chosen === 'object') {
      const settings = chosen as Pick<
        SchoolClass,
        'name' | 'schoolYear' | 'minimums' | 'includeArchivedInCount'
      >;
      return {
        ...db,
        updatedAt: new Date().toISOString(),
        classes: db.classes.map((c) =>
          c.id === conflict.classId
            ? {
                ...c,
                name: settings.name,
                schoolYear: settings.schoolYear,
                minimums: clone(settings.minimums),
                includeArchivedInCount: settings.includeArchivedInCount,
              }
            : c
        ),
      };
    }

    // Class deletion vs modification conflict
    if (chosen === null) {
      const remaining = db.classes.filter((c) => c.id !== conflict.classId);
      return {
        ...db,
        updatedAt: new Date().toISOString(),
        activeClassId:
          db.activeClassId === conflict.classId
            ? remaining[0]?.id ?? null
            : db.activeClassId,
        classes: remaining,
      };
    }
    const clsSnapshot = clone(chosen as SchoolClass);
    const exists = db.classes.some((c) => c.id === clsSnapshot.id);
    return {
      ...db,
      updatedAt: new Date().toISOString(),
      classes: exists
        ? db.classes.map((c) => (c.id === clsSnapshot.id ? clsSnapshot : c))
        : [...db.classes, clsSnapshot],
    };
  }

  return {
    ...db,
    updatedAt: new Date().toISOString(),
    classes: db.classes.map((cls) => {
      if (cls.id !== conflict.classId) return cls;

      if (conflict.scope === 'activity') {
        const actId = conflict.meta?.activityId || conflict.entityId;
        if (chosen === null) {
          return {
            ...cls,
            activities: cls.activities.filter((a) => a.id !== actId),
          };
        }
        const actSnap = clone(chosen as Activity);
        const exists = cls.activities.some((a) => a.id === actSnap.id);
        return {
          ...cls,
          activities: exists
            ? cls.activities.map((a) => (a.id === actSnap.id ? actSnap : a))
            : [...cls.activities, actSnap],
        };
      }

      if (conflict.scope === 'student') {
        const stuId = conflict.meta?.studentId || conflict.entityId;
        if (conflict.meta?.field === 'student_profile' && chosen && typeof chosen === 'object') {
          const prof = chosen as Pick<Student, 'lastName' | 'firstName' | 'notes'>;
          return {
            ...cls,
            students: cls.students.map((s) =>
              s.id === stuId
                ? {
                    ...s,
                    lastName: prof.lastName,
                    firstName: prof.firstName,
                    notes: prof.notes,
                  }
                : s
            ),
          };
        }
        if (chosen === null) {
          return {
            ...cls,
            students: cls.students.filter((s) => s.id !== stuId),
          };
        }
        const stuSnap = clone(chosen as Student);
        const exists = cls.students.some((s) => s.id === stuSnap.id);
        return {
          ...cls,
          students: exists
            ? cls.students.map((s) => (s.id === stuSnap.id ? stuSnap : s))
            : [...cls.students, stuSnap],
        };
      }

      if (conflict.scope === 'cell') {
        const stuId = conflict.meta?.studentId;
        const actId = conflict.meta?.activityId;
        const status = chosen as CompletionStatus;
        if (!stuId || !actId) return cls;
        return {
          ...cls,
          students: cls.students.map((s) => {
            if (s.id !== stuId) return s;
            const nextRecords = { ...s.records };
            if (status === 'PENDENTE') {
              delete nextRecords[actId];
            } else {
              nextRecords[actId] = status;
            }
            return { ...s, records: nextRecords };
          }),
        };
      }

      return cls;
    }),
  };
}

export { createEmptyTombstones };
