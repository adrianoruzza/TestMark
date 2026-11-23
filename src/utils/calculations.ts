import {
  Activity,
  ActivityCategory,
  ArchivedActivityEntry,
  CATEGORY_META,
  CATEGORY_ORDER,
  CompletionStatus,
  SchoolClass,
  Student,
  generateId,
} from '../types';

export interface CategoryEvaluation {
  category: ActivityCategory;
  completedCurrent: number;
  completedArchived: number;
  completedTotal: number;
  minimum: number;
  missing: number;
  met: boolean;
  absentCount: number;
  notDoneCount: number;
  pendingCount: number;
}

export interface MissedActivityDetail {
  activityId: string;
  title: string;
  category: ActivityCategory;
  date: string;
  status: 'ASSENTE' | 'NON_SVOLTO';
  fromArchive?: string;
}

export interface StudentEvaluation {
  student: Student;
  schoolClass: SchoolClass;
  byCategory: Record<ActivityCategory, CategoryEvaluation>;
  allRequirementsMet: boolean;
  totalMissing: number;
  totalCompleted: number;
  totalMinimum: number;
  totalAbsent: number;
  totalNotDone: number;
  deficitParts: string[];
  deficitSummary: string;
  missedActivities: MissedActivityDetail[];
}

export function sortActivitiesChronologically(activities: Activity[]): Activity[] {
  return [...activities].sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) return dateCmp;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export function sortStudentsAlphabetically(students: Student[]): Student[] {
  return [...students].sort((a, b) => {
    const lastCmp = a.lastName.localeCompare(b.lastName, 'it', { sensitivity: 'base' });
    if (lastCmp !== 0) return lastCmp;
    return a.firstName.localeCompare(b.firstName, 'it', { sensitivity: 'base' });
  });
}

export function getStudentStatus(student: Student, activityId: string): CompletionStatus {
  return student.records[activityId] ?? 'PENDENTE';
}

export function evaluateStudent(
  student: Student,
  schoolClass: SchoolClass
): StudentEvaluation {
  const byCategory = {} as Record<ActivityCategory, CategoryEvaluation>;
  const missedActivities: MissedActivityDetail[] = [];

  for (const cat of CATEGORY_ORDER) {
    byCategory[cat] = {
      category: cat,
      completedCurrent: 0,
      completedArchived: 0,
      completedTotal: 0,
      minimum: Math.max(0, Number(schoolClass.minimums[cat]) || 0),
      missing: 0,
      met: true,
      absentCount: 0,
      notDoneCount: 0,
      pendingCount: 0,
    };
  }

  const sortedActivities = sortActivitiesChronologically(schoolClass.activities);

  for (const act of sortedActivities) {
    const status = getStudentStatus(student, act.id);
    const bucket = byCategory[act.category];
    if (!bucket) continue;

    if (status === 'SVOLTO') {
      bucket.completedCurrent += 1;
    } else if (status === 'ASSENTE') {
      bucket.absentCount += 1;
      missedActivities.push({
        activityId: act.id,
        title: act.title,
        category: act.category,
        date: act.date,
        status: 'ASSENTE',
      });
    } else if (status === 'NON_SVOLTO') {
      bucket.notDoneCount += 1;
      missedActivities.push({
        activityId: act.id,
        title: act.title,
        category: act.category,
        date: act.date,
        status: 'NON_SVOLTO',
      });
    } else {
      bucket.pendingCount += 1;
    }
  }

  if (schoolClass.includeArchivedInCount && student.archivedHistory?.length) {
    for (const entry of student.archivedHistory) {
      const bucket = byCategory[entry.category];
      if (!bucket) continue;
      if (entry.status === 'SVOLTO') {
        bucket.completedArchived += 1;
      }
    }
  }

  let allRequirementsMet = true;
  let totalMissing = 0;
  let totalCompleted = 0;
  let totalMinimum = 0;
  let totalAbsent = 0;
  let totalNotDone = 0;
  const deficitParts: string[] = [];

  for (const cat of CATEGORY_ORDER) {
    const bucket = byCategory[cat];
    bucket.completedTotal = bucket.completedCurrent + bucket.completedArchived;
    bucket.missing = Math.max(0, bucket.minimum - bucket.completedTotal);
    bucket.met = bucket.completedTotal >= bucket.minimum;

    if (!bucket.met) {
      allRequirementsMet = false;
      const meta = CATEGORY_META[cat];
      const label = bucket.missing === 1 ? meta.singularDeficit : meta.pluralDeficit;
      deficitParts.push(`${bucket.missing} ${label}`);
    }

    totalMissing += bucket.missing;
    totalCompleted += bucket.completedTotal;
    totalMinimum += bucket.minimum;
    totalAbsent += bucket.absentCount;
    totalNotDone += bucket.notDoneCount;
  }

  const deficitSummary =
    deficitParts.length === 0 ? 'Requisiti soddisfatti' : deficitParts.join(', ');

  return {
    student,
    schoolClass,
    byCategory,
    allRequirementsMet,
    totalMissing,
    totalCompleted,
    totalMinimum,
    totalAbsent,
    totalNotDone,
    deficitParts,
    deficitSummary,
    missedActivities,
  };
}

export function buildArchivedEntriesFromClass(
  student: Student,
  sourceClass: SchoolClass
): ArchivedActivityEntry[] {
  const existingKeys = new Set(
    (student.archivedHistory || []).map(
      (item) => `${item.sourceClassName.toLowerCase()}::${item.activityId}`
    )
  );
  const now = new Date().toISOString();
  const additions: ArchivedActivityEntry[] = [];

  for (const act of sortActivitiesChronologically(sourceClass.activities)) {
    const status = getStudentStatus(student, act.id);
    if (status === 'PENDENTE') continue;
    const key = `${sourceClass.name.toLowerCase()}::${act.id}`;
    if (existingKeys.has(key)) continue;

    additions.push({
      id: generateId('arch'),
      sourceClassName: sourceClass.name,
      activityId: act.id,
      activityTitle: act.title,
      category: act.category,
      date: act.date,
      status,
      notes: act.notes,
      archivedAt: now,
    });
  }

  return [...(student.archivedHistory || []), ...additions];
}

export function formatShortDate(isoDate: string): string {
  if (!isoDate) return '';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  const d = new Date(year, month, day);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
  });
}

export function formatFullDate(isoDate: string): string {
  if (!isoDate) return '';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  const d = new Date(year, month, day);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function normalizeNameKey(lastName: string, firstName: string): string {
  return `${lastName.trim().toLowerCase().replace(/\s+/g, ' ')}|${firstName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')}`;
}
