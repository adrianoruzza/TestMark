export type ActivityCategory =
  | 'COMPITO_GRAFICO'
  | 'INTERROGAZIONE_ORALE'
  | 'CONSEGNA_PRATICO';

export type CompletionStatus = 'SVOLTO' | 'ASSENTE' | 'NON_SVOLTO' | 'PENDENTE';

export type RecordedStatus = Exclude<CompletionStatus, 'PENDENTE'>;

export interface Activity {
  id: string;
  title: string;
  category: ActivityCategory;
  date: string; // ISO YYYY-MM-DD
  notes?: string;
  createdAt: string;
}

export interface ArchivedActivityEntry {
  id: string;
  sourceClassName: string;
  activityId: string;
  activityTitle: string;
  category: ActivityCategory;
  date: string;
  status: RecordedStatus;
  notes?: string;
  archivedAt: string;
}

export interface Student {
  id: string;
  lastName: string;
  firstName: string;
  notes?: string;
  records: Record<string, CompletionStatus>;
  archivedHistory: ArchivedActivityEntry[];
  createdAt: string;
}

export interface CategoryMinimums {
  COMPITO_GRAFICO: number;
  INTERROGAZIONE_ORALE: number;
  CONSEGNA_PRATICO: number;
}

export interface SchoolClass {
  id: string;
  name: string;
  schoolYear: string;
  minimums: CategoryMinimums;
  includeArchivedInCount: boolean;
  activities: Activity[];
  students: Student[];
  createdAt: string;
}

export interface AppDatabase {
  version: number;
  updatedAt: string;
  activeClassId: string | null;
  classes: SchoolClass[];
}

export type AppView = 'registro' | 'resoconto' | 'archivio';

export const CATEGORY_ORDER: ActivityCategory[] = [
  'COMPITO_GRAFICO',
  'INTERROGAZIONE_ORALE',
  'CONSEGNA_PRATICO',
];

export const CATEGORY_META: Record<
  ActivityCategory,
  {
    label: string;
    pluralLabel: string;
    shortLabel: string;
    code: string;
    singularDeficit: string;
    pluralDeficit: string;
    headerBg: string;
    headerBorder: string;
    headerText: string;
    accentBar: string;
    subtleText: string;
  }
> = {
  COMPITO_GRAFICO: {
    label: 'Compito grafico',
    pluralLabel: 'Compiti grafici',
    shortLabel: 'Grafico',
    code: 'G',
    singularDeficit: 'compito grafico',
    pluralDeficit: 'compiti grafici',
    headerBg: 'bg-sky-50/75',
    headerBorder: 'border-b-sky-400',
    headerText: 'text-sky-900',
    accentBar: 'bg-sky-500',
    subtleText: 'text-sky-700',
  },
  INTERROGAZIONE_ORALE: {
    label: 'Interrogazione orale',
    pluralLabel: 'Interrogazioni orali',
    shortLabel: 'Orale',
    code: 'O',
    singularDeficit: 'interrogazione orale',
    pluralDeficit: 'interrogazioni orali',
    headerBg: 'bg-violet-50/75',
    headerBorder: 'border-b-violet-400',
    headerText: 'text-violet-900',
    accentBar: 'bg-violet-500',
    subtleText: 'text-violet-700',
  },
  CONSEGNA_PRATICO: {
    label: 'Consegna pratico',
    pluralLabel: 'Consegne pratiche',
    shortLabel: 'Pratico',
    code: 'P',
    singularDeficit: 'consegna pratica',
    pluralDeficit: 'consegne pratiche',
    headerBg: 'bg-teal-50/75',
    headerBorder: 'border-b-teal-400',
    headerText: 'text-teal-900',
    accentBar: 'bg-teal-500',
    subtleText: 'text-teal-700',
  },
};

export const STATUS_META: Record<
  CompletionStatus,
  {
    label: string;
    shortLabel: string;
    description: string;
    cellBg: string;
    cellHover: string;
    cellText: string;
    cellBorder: string;
  }
> = {
  SVOLTO: {
    label: 'Svolto',
    shortLabel: 'Svolto',
    description: 'Prova effettuata o lavoro consegnato',
    cellBg: 'bg-emerald-100/90',
    cellHover: 'hover:bg-emerald-200/80',
    cellText: 'text-emerald-900',
    cellBorder: 'border-emerald-300/80',
  },
  ASSENTE: {
    label: 'Assente',
    shortLabel: 'Assente',
    description: 'Assente nel giorno della prova (da recuperare)',
    cellBg: 'bg-amber-100/95',
    cellHover: 'hover:bg-amber-200/85',
    cellText: 'text-amber-900',
    cellBorder: 'border-amber-300/85',
  },
  NON_SVOLTO: {
    label: 'Non svolto',
    shortLabel: 'Non svolto',
    description: 'Prova non effettuata o lavoro non consegnato',
    cellBg: 'bg-rose-100/90',
    cellHover: 'hover:bg-rose-200/80',
    cellText: 'text-rose-900',
    cellBorder: 'border-rose-300/80',
  },
  PENDENTE: {
    label: 'Non registrato',
    shortLabel: '—',
    description: 'In attesa di registrazione',
    cellBg: 'bg-white',
    cellHover: 'hover:bg-slate-100/90',
    cellText: 'text-slate-400',
    cellBorder: 'border-slate-200/70',
  },
};

export const DEFAULT_MINIMUMS: CategoryMinimums = {
  COMPITO_GRAFICO: 3,
  INTERROGAZIONE_ORALE: 2,
  CONSEGNA_PRATICO: 2,
};

export function generateId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
