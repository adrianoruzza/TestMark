import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  CheckCircle2,
  FileSpreadsheet,
  FolderPlus,
  Plus,
  Redo2,
  Search,
  Settings2,
  Undo2,
  UserPlus,
} from 'lucide-react';
import { ActivityModal } from './components/ActivityModal';
import { ArchiveSettingsView } from './components/ArchiveSettingsView';
import { ClassSettingsModal } from './components/ClassSettingsModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MoveCopyStudentModal } from './components/MoveCopyStudentModal';
import { PWAInstallButton, PWAStatusOverlay } from './components/PWAControls';
import { RegisterTable } from './components/RegisterTable';
import { ResocontoView } from './components/ResocontoView';
import { StudentHistoryModal } from './components/StudentHistoryModal';
import { StudentModal } from './components/StudentModal';
import { useUndoableDatabase } from './hooks/useUndoableDatabase';
import {
  Activity,
  ActivityCategory,
  AppDatabase,
  AppView,
  CATEGORY_META,
  CATEGORY_ORDER,
  CategoryMinimums,
  CompletionStatus,
  STATUS_META,
  SchoolClass,
  Student,
  generateId,
} from './types';
import {
  buildArchivedEntriesFromClass,
  evaluateStudent,
} from './utils/calculations';
import { exportClassToExcel } from './utils/excelExport';

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  variant: 'danger' | 'primary';
  onConfirm: () => void;
}

export default function App() {
  const {
    db,
    canUndo,
    canRedo,
    nextUndoLabel,
    nextRedoLabel,
    commitChange,
    setActiveClassId,
    undo,
    redo,
  } = useUndoableDatabase();

  const [view, setView] = useState<AppView>('registro');

  // Register filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | 'ALL'>('ALL');
  const [requirementFilter, setRequirementFilter] = useState<'ALL' | 'OK' | 'CARENZA'>('ALL');

  // Modals state
  const [activityModalOpen, setActivityModalOpen] = useState(false);
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);

  const [studentModalOpen, setStudentModalOpen] = useState(false);
  const [studentModalTab, setStudentModalTab] = useState<'manual' | 'import'>('manual');

  const [classModalOpen, setClassModalOpen] = useState(false);
  const [classModalMode, setClassModalMode] = useState<'create' | 'edit'>('create');
  const [editingClassTarget, setEditingClassTarget] = useState<SchoolClass | null>(null);

  const [moveCopyOpen, setMoveCopyOpen] = useState(false);
  const [moveCopyStudentId, setMoveCopyStudentId] = useState<string | null>(null);

  const [historyStudentId, setHistoryStudentId] = useState<string | null>(null);

  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  const anyModalOpen =
    activityModalOpen ||
    studentModalOpen ||
    classModalOpen ||
    moveCopyOpen ||
    Boolean(historyStudentId) ||
    Boolean(confirmState);

  const handleUndo = useCallback(() => {
    const label = undo();
    if (label) {
      showToast(`Annullato: ${label}`);
    }
  }, [undo, showToast]);

  const handleRedo = useCallback(() => {
    const label = redo();
    if (label) {
      showToast(`Ripristinato: ${label}`);
    }
  }, [redo, showToast]);

  // Global keyboard shortcuts: Ctrl+Z (Undo), Ctrl+Y / Ctrl+Shift+Z (Redo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (anyModalOpen) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [anyModalOpen, handleUndo, handleRedo]);

  const activeClass = useMemo<SchoolClass | null>(() => {
    if (db.classes.length === 0) return null;
    return db.classes.find((c) => c.id === db.activeClassId) ?? db.classes[0];
  }, [db.classes, db.activeClassId]);

  const historyStudent = useMemo<Student | null>(() => {
    if (!activeClass || !historyStudentId) return null;
    return activeClass.students.find((s) => s.id === historyStudentId) ?? null;
  }, [activeClass, historyStudentId]);

  const activeClassStats = useMemo(() => {
    if (!activeClass) return { total: 0, ok: 0, carenze: 0 };
    const total = activeClass.students.length;
    const ok = activeClass.students.filter(
      (s) => evaluateStudent(s, activeClass).allRequirementsMet
    ).length;
    return { total, ok, carenze: total - ok };
  }, [activeClass]);

  const globalCarenzeCount = useMemo(() => {
    let count = 0;
    for (const cls of db.classes) {
      for (const stu of cls.students) {
        if (!evaluateStudent(stu, cls).allRequirementsMet) {
          count += 1;
        }
      }
    }
    return count;
  }, [db.classes]);

  const commitClassUpdate = useCallback(
    (classId: string, label: string, updater: (cls: SchoolClass) => SchoolClass) => {
      commitChange(label, (prev) => ({
        ...prev,
        classes: prev.classes.map((c) => (c.id === classId ? updater(c) : c)),
      }));
    },
    [commitChange]
  );

  // Class navigation (excluded from UNDO/REDO history)
  const handleSelectClass = (classId: string) => {
    setActiveClassId(classId);
    setSearchQuery('');
    setCategoryFilter('ALL');
    setRequirementFilter('ALL');
  };

  const handleOpenClassFromView = (classId: string) => {
    handleSelectClass(classId);
    setView('registro');
  };

  // Class CRUD (recorded in UNDO/REDO history)
  const handleSaveClassSettings = (payload: {
    name: string;
    schoolYear: string;
    minimums: CategoryMinimums;
    includeArchivedInCount: boolean;
  }) => {
    if (classModalMode === 'create') {
      const newClass: SchoolClass = {
        id: generateId('cls'),
        name: payload.name,
        schoolYear: payload.schoolYear,
        minimums: payload.minimums,
        includeArchivedInCount: payload.includeArchivedInCount,
        activities: [],
        students: [],
        createdAt: new Date().toISOString(),
      };
      commitChange(`Classe ${newClass.name} creata`, (prev) => ({
        ...prev,
        activeClassId: newClass.id,
        classes: [...prev.classes, newClass],
      }));
      setView('registro');
      showToast(`Classe ${newClass.name} creata.`);
    } else if (editingClassTarget) {
      commitClassUpdate(
        editingClassTarget.id,
        `Impostazioni classe ${payload.name}`,
        (cls) => ({
          ...cls,
          name: payload.name,
          schoolYear: payload.schoolYear,
          minimums: payload.minimums,
          includeArchivedInCount: payload.includeArchivedInCount,
        })
      );
      showToast(`Impostazioni classe ${payload.name} aggiornate.`);
    }
    setClassModalOpen(false);
    setEditingClassTarget(null);
  };

  const handleRequestDeleteClass = (cls: SchoolClass) => {
    setConfirmState({
      title: `Eliminare la classe ${cls.name}?`,
      description: `Verranno rimossi ${cls.students.length} studenti e ${cls.activities.length} attività della classe ${cls.name}. Potrai comunque annullare con UNDO.`,
      confirmLabel: 'Elimina classe',
      variant: 'danger',
      onConfirm: () => {
        commitChange(`Eliminazione classe ${cls.name}`, (prev) => {
          const remaining = prev.classes.filter((c) => c.id !== cls.id);
          return {
            ...prev,
            classes: remaining,
            activeClassId:
              prev.activeClassId === cls.id
                ? remaining[0]?.id ?? null
                : prev.activeClassId,
          };
        });
        setClassModalOpen(false);
        setEditingClassTarget(null);
        setConfirmState(null);
        showToast(`Classe ${cls.name} eliminata.`);
      },
    });
  };

  // Activity CRUD
  const handleSaveActivity = (payload: {
    title: string;
    category: ActivityCategory;
    date: string;
    notes: string;
  }) => {
    if (!activeClass) return;

    if (editingActivity) {
      commitClassUpdate(
        activeClass.id,
        `Modifica attività "${payload.title}"`,
        (cls) => ({
          ...cls,
          activities: cls.activities.map((a) =>
            a.id === editingActivity.id
              ? {
                  ...a,
                  title: payload.title,
                  category: payload.category,
                  date: payload.date,
                  notes: payload.notes || undefined,
                }
              : a
          ),
        })
      );
      showToast(`Attività "${payload.title}" aggiornata.`);
    } else {
      const newActivity: Activity = {
        id: generateId('act'),
        title: payload.title,
        category: payload.category,
        date: payload.date,
        notes: payload.notes || undefined,
        createdAt: new Date().toISOString(),
      };
      commitClassUpdate(
        activeClass.id,
        `Nuova attività "${payload.title}"`,
        (cls) => ({
          ...cls,
          activities: [...cls.activities, newActivity],
        })
      );
      showToast(`Attività "${payload.title}" aggiunta.`);
    }
    setActivityModalOpen(false);
    setEditingActivity(null);
  };

  const handleRequestDeleteActivity = (activity: Activity) => {
    if (!activeClass) return;
    setConfirmState({
      title: `Eliminare l'attività "${activity.title}"?`,
      description: `Verrà rimossa la colonna "${activity.title}" e tutte le relative registrazioni nella classe ${activeClass.name}.`,
      confirmLabel: 'Elimina attività',
      variant: 'danger',
      onConfirm: () => {
        commitClassUpdate(
          activeClass.id,
          `Eliminazione attività "${activity.title}"`,
          (cls) => ({
            ...cls,
            activities: cls.activities.filter((a) => a.id !== activity.id),
            students: cls.students.map((stu) => {
              const nextRecords = { ...stu.records };
              delete nextRecords[activity.id];
              return { ...stu, records: nextRecords };
            }),
          })
        );
        setActivityModalOpen(false);
        setEditingActivity(null);
        setConfirmState(null);
        showToast(`Attività "${activity.title}" eliminata.`);
      },
    });
  };

  // Cell Status Update
  const handleUpdateStatus = useCallback(
    (studentId: string, activityId: string, status: CompletionStatus) => {
      if (!activeClass) return;
      const stu = activeClass.students.find((s) => s.id === studentId);
      const currentStatus = stu?.records[activityId] ?? 'PENDENTE';
      if (currentStatus === status) return;

      const label = stu
        ? `${stu.lastName} → ${STATUS_META[status].label}`
        : `Stato → ${STATUS_META[status].label}`;

      commitClassUpdate(activeClass.id, label, (cls) => ({
        ...cls,
        students: cls.students.map((s) => {
          if (s.id !== studentId) return s;
          const nextRecords = { ...s.records };
          if (status === 'PENDENTE') {
            delete nextRecords[activityId];
          } else {
            nextRecords[activityId] = status;
          }
          return { ...s, records: nextRecords };
        }),
      }));
    },
    [activeClass, commitClassUpdate]
  );

  const handleBulkSetActivityStatus = useCallback(
    (activityId: string, status: CompletionStatus, onlyPending: boolean) => {
      if (!activeClass) return;
      const act = activeClass.activities.find((a) => a.id === activityId);
      const label =
        status === 'SVOLTO'
          ? `Pendenti svolti (${act?.title || 'attività'})`
          : `Azzeramento colonna (${act?.title || 'attività'})`;

      commitClassUpdate(activeClass.id, label, (cls) => ({
        ...cls,
        students: cls.students.map((stu) => {
          const current = stu.records[activityId] ?? 'PENDENTE';
          if (onlyPending && current !== 'PENDENTE') return stu;
          const nextRecords = { ...stu.records };
          if (status === 'PENDENTE') {
            delete nextRecords[activityId];
          } else {
            nextRecords[activityId] = status;
          }
          return { ...stu, records: nextRecords };
        }),
      }));
      showToast(
        status === 'SVOLTO'
          ? 'Studenti pendenti segnati come Svolti.'
          : 'Colonna ripristinata a Non registrato.'
      );
    },
    [activeClass, commitClassUpdate, showToast]
  );

  // Student CRUD
  const handleAddStudents = (
    entries: { lastName: string; firstName: string; notes?: string }[]
  ) => {
    if (!activeClass || entries.length === 0) return;
    const now = new Date().toISOString();
    const created: Student[] = entries.map((e) => ({
      id: generateId('stu'),
      lastName: e.lastName,
      firstName: e.firstName,
      notes: e.notes,
      records: {},
      archivedHistory: [],
      createdAt: now,
    }));

    const label =
      created.length === 1
        ? `Aggiunto ${created[0].lastName} ${created[0].firstName}`
        : `Importati ${created.length} studenti in ${activeClass.name}`;

    commitClassUpdate(activeClass.id, label, (cls) => ({
      ...cls,
      students: [...cls.students, ...created],
    }));

    showToast(
      created.length === 1
        ? `Studente ${created[0].lastName} ${created[0].firstName} aggiunto.`
        : `${created.length} studenti aggiunti alla classe ${activeClass.name}.`
    );
  };

  const handleUpdateStudent = (
    studentId: string,
    payload: { lastName: string; firstName: string; notes: string }
  ) => {
    if (!activeClass) return;
    commitClassUpdate(
      activeClass.id,
      `Modifica studente ${payload.lastName} ${payload.firstName}`,
      (cls) => ({
        ...cls,
        students: cls.students.map((s) =>
          s.id === studentId
            ? {
                ...s,
                lastName: payload.lastName,
                firstName: payload.firstName,
                notes: payload.notes || undefined,
              }
            : s
        ),
      })
    );
    showToast('Dati dello studente aggiornati.');
  };

  const handleDeleteArchivedEntry = (studentId: string, archivedEntryId: string) => {
    if (!activeClass) return;
    commitClassUpdate(activeClass.id, 'Rimozione voce storico studente', (cls) => ({
      ...cls,
      students: cls.students.map((s) =>
        s.id === studentId
          ? {
              ...s,
              archivedHistory: s.archivedHistory.filter(
                (h) => h.id !== archivedEntryId
              ),
            }
          : s
      ),
    }));
  };

  const handleRequestDeleteStudent = (student: Student) => {
    if (!activeClass) return;
    setConfirmState({
      title: `Eliminare ${student.lastName} ${student.firstName}?`,
      description: `Lo studente e tutte le sue registrazioni nella classe ${activeClass.name} verranno rimossi.`,
      confirmLabel: 'Elimina studente',
      variant: 'danger',
      onConfirm: () => {
        commitClassUpdate(
          activeClass.id,
          `Eliminazione ${student.lastName} ${student.firstName}`,
          (cls) => ({
            ...cls,
            students: cls.students.filter((s) => s.id !== student.id),
          })
        );
        setHistoryStudentId(null);
        setConfirmState(null);
        showToast(`${student.lastName} ${student.firstName} eliminato.`);
      },
    });
  };

  // Move / Copy Student between classes preserving historical records
  const handleMoveCopyStudent = ({
    studentId,
    targetClassId,
    operation,
  }: {
    studentId: string;
    targetClassId: string;
    operation: 'move' | 'copy';
  }) => {
    if (!activeClass) return;
    const student = activeClass.students.find((s) => s.id === studentId);
    const targetClass = db.classes.find((c) => c.id === targetClassId);
    if (!student || !targetClass) return;

    const preservedHistory = buildArchivedEntriesFromClass(student, activeClass);

    const transferredStudent: Student = {
      id: operation === 'move' ? student.id : generateId('stu'),
      lastName: student.lastName,
      firstName: student.firstName,
      notes: student.notes,
      records: {},
      archivedHistory: preservedHistory,
      createdAt: student.createdAt,
    };

    const actionLabel =
      operation === 'move'
        ? `Spostato ${student.lastName} in ${targetClass.name}`
        : `Copiato ${student.lastName} in ${targetClass.name}`;

    commitChange(actionLabel, (prev) => ({
      ...prev,
      classes: prev.classes.map((cls) => {
        if (cls.id === activeClass.id && operation === 'move') {
          return {
            ...cls,
            students: cls.students.filter((s) => s.id !== student.id),
          };
        }
        if (cls.id === targetClassId) {
          return {
            ...cls,
            students: [...cls.students, transferredStudent],
          };
        }
        return cls;
      }),
    }));

    setMoveCopyOpen(false);
    setMoveCopyStudentId(null);
    showToast(
      operation === 'move'
        ? `${student.lastName} ${student.firstName} spostato in ${targetClass.name}.`
        : `${student.lastName} ${student.firstName} copiato in ${targetClass.name}.`
    );
  };

  // Backup restore
  const handleRestoreBackup = (backup: AppDatabase, mode: 'replace' | 'merge') => {
    if (mode === 'replace') {
      setConfirmState({
        title: 'Sostituire l’archivio attuale con il backup?',
        description: `Tutti i dati attuali verranno sostituiti con le ${backup.classes.length} classi del backup selezionato.`,
        confirmLabel: 'Sostituisci archivio',
        variant: 'danger',
        onConfirm: () => {
          commitChange('Ripristino backup completo', () => ({
            ...backup,
            updatedAt: new Date().toISOString(),
          }));
          setConfirmState(null);
          showToast('Backup ripristinato correttamente.');
        },
      });
    } else {
      commitChange('Unione classi da backup', (prev) => {
        const existingNames = new Set(
          prev.classes.map((c) => c.name.trim().toLowerCase())
        );
        const importedClasses = backup.classes.map((c) => {
          let nextName = c.name;
          if (existingNames.has(nextName.trim().toLowerCase())) {
            nextName = `${c.name} (backup)`;
          }
          existingNames.add(nextName.trim().toLowerCase());
          return {
            ...c,
            id: generateId('cls'),
            name: nextName,
          };
        });
        return {
          ...prev,
          classes: [...prev.classes, ...importedClasses],
          activeClassId: prev.activeClassId ?? importedClasses[0]?.id ?? null,
        };
      });
      showToast('Classi del backup aggiunte all’archivio.');
    }
  };

  const openCreateClassModal = () => {
    setClassModalMode('create');
    setEditingClassTarget(null);
    setClassModalOpen(true);
  };

  const openEditClassModal = (cls: SchoolClass) => {
    setClassModalMode('edit');
    setEditingClassTarget(cls);
    setClassModalOpen(true);
  };

  return (
    <div
      className={`flex flex-col bg-slate-50 text-slate-900 ${
        view === 'registro' ? 'h-screen overflow-hidden' : 'min-h-screen'
      }`}
    >
      {/* Ultra-Compact Top Bar (44px) optimized for Tablet & Desktop */}
      <header className="no-print sticky top-0 z-40 shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-11 max-w-[1600px] items-center justify-between gap-3 px-2.5 sm:gap-6 sm:px-4">
          {/* Zone 1: Brand Title */}
          <button
            type="button"
            onClick={() => setView('registro')}
            className="font-display text-sm font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus:outline-none sm:text-base"
          >
            Registro Prove
          </button>

          {/* Zone 2: Navigation Links */}
          <nav
            aria-label="Navigazione principale"
            className="flex items-center gap-4 text-xs font-medium sm:gap-6 sm:text-sm"
          >
            <button
              type="button"
              onClick={() => setView('registro')}
              className={`relative flex h-11 items-center transition-colors whitespace-nowrap shrink-0 ${
                view === 'registro'
                  ? 'text-blue-700 font-semibold after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-blue-700'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Registro
            </button>
            <button
              type="button"
              onClick={() => setView('resoconto')}
              className={`relative flex h-11 items-center transition-colors whitespace-nowrap shrink-0 ${
                view === 'resoconto'
                  ? 'text-blue-700 font-semibold after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-blue-700'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Resoconto
              {globalCarenzeCount > 0 && (
                <span className="ml-1 font-mono text-[11px] text-amber-700 tabular-nums">
                  ({globalCarenzeCount})
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setView('archivio')}
              className={`relative flex h-11 items-center transition-colors whitespace-nowrap shrink-0 ${
                view === 'archivio'
                  ? 'text-blue-700 font-semibold after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-blue-700'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span className="sm:hidden">Classi</span>
              <span className="hidden sm:inline">Classi e Backup</span>
            </button>
          </nav>

          {/* Zone 3: Discrete PWA Install (hidden when installed) + UNDO / REDO + 1 Contextual Primary Action */}
          <div className="flex items-center gap-1.5 shrink-0 sm:gap-2">
            <PWAInstallButton />
            <div
              className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50/70 p-0.5"
              role="group"
              aria-label="Cronologia modifiche"
            >
              <button
                type="button"
                onClick={handleUndo}
                disabled={!canUndo}
                title={
                  canUndo
                    ? `Annulla: ${nextUndoLabel} (Ctrl+Z)`
                    : 'Nessuna operazione da annullare (Ctrl+Z)'
                }
                aria-label="Annulla ultima modifica"
                className="inline-flex h-8 min-w-[34px] items-center justify-center gap-1 rounded px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent whitespace-nowrap"
              >
                <Undo2 className="h-4 w-4" />
                <span className="hidden lg:inline">Annulla</span>
              </button>
              <div className="h-4 w-px bg-slate-200" aria-hidden="true" />
              <button
                type="button"
                onClick={handleRedo}
                disabled={!canRedo}
                title={
                  canRedo
                    ? `Ripristina: ${nextRedoLabel} (Ctrl+Y)`
                    : 'Nessuna operazione da ripristinare (Ctrl+Y)'
                }
                aria-label="Ripristina modifica annullata"
                className="inline-flex h-8 min-w-[34px] items-center justify-center gap-1 rounded px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent whitespace-nowrap"
              >
                <Redo2 className="h-4 w-4" />
                <span className="hidden lg:inline">Ripristina</span>
              </button>
            </div>

            {view === 'registro' && activeClass && (
              <button
                type="button"
                onClick={() => {
                  setEditingActivity(null);
                  setActivityModalOpen(true);
                }}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-blue-700 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-800 whitespace-nowrap shrink-0 sm:px-3"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Attività</span>
              </button>
            )}

            {(view === 'archivio' || (view === 'registro' && !activeClass)) && (
              <button
                type="button"
                onClick={openCreateClassModal}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-blue-700 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-800 whitespace-nowrap shrink-0 sm:px-3"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                <span>Classe</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      {view === 'registro' && (
        <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col gap-2 px-2 py-2 sm:px-3">
          {!activeClass ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-slate-200 bg-white p-8 text-center">
              <h1 className="text-base font-semibold text-slate-900">
                Nessuna classe presente
              </h1>
              <p className="mt-1 max-w-md text-xs text-slate-600 sm:text-sm">
                Crea la prima classe per iniziare a registrare compiti grafici, interrogazioni orali e consegne pratiche.
              </p>
              <button
                type="button"
                onClick={openCreateClassModal}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-800 whitespace-nowrap"
              >
                <FolderPlus className="h-4 w-4" />
                Crea prima classe
              </button>
            </div>
          ) : (
            <>
              {/* Single Unified Compact Command Bar (Class + Filters + Secondary Actions) */}
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 sm:gap-2">
                {/* Left: Class Selector + Compact Filters */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex items-center gap-1">
                    <select
                      id="class-selector"
                      aria-label="Seleziona classe"
                      value={activeClass.id}
                      onChange={(e) => handleSelectClass(e.target.value)}
                      className="h-9 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-900 focus:border-blue-600 focus:outline-none sm:text-sm"
                    >
                      {db.classes.map((cls) => (
                        <option key={cls.id} value={cls.id}>
                          {cls.name} ({cls.schoolYear})
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={openCreateClassModal}
                      title="Crea nuova classe"
                      aria-label="Crea nuova classe"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-slate-700 transition-colors hover:bg-slate-100"
                    >
                      <FolderPlus className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="relative w-32 sm:w-40">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Cerca..."
                      aria-label="Cerca studente"
                      className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                    />
                  </div>

                  <select
                    aria-label="Filtra per categoria"
                    value={categoryFilter}
                    onChange={(e) =>
                      setCategoryFilter(e.target.value as ActivityCategory | 'ALL')
                    }
                    className="h-9 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
                  >
                    <option value="ALL">
                      Tutte ({activeClass.activities.length})
                    </option>
                    {CATEGORY_ORDER.map((cat) => {
                      const count = activeClass.activities.filter(
                        (a) => a.category === cat
                      ).length;
                      return (
                        <option key={cat} value={cat}>
                          {CATEGORY_META[cat].shortLabel} ({count})
                        </option>
                      );
                    })}
                  </select>

                  <select
                    aria-label="Filtra per stato requisiti"
                    value={requirementFilter}
                    onChange={(e) =>
                      setRequirementFilter(
                        e.target.value as 'ALL' | 'OK' | 'CARENZA'
                      )
                    }
                    className="h-9 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
                  >
                    <option value="ALL">Tutti ({activeClassStats.total})</option>
                    <option value="CARENZA">
                      Carenze ({activeClassStats.carenze})
                    </option>
                    <option value="OK">In regola ({activeClassStats.ok})</option>
                  </select>
                </div>

                {/* Right: Essential Icon-First Class Actions */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setStudentModalTab('manual');
                      setStudentModalOpen(true);
                    }}
                    title="Aggiungi o importa studenti (.xlsx, .docx, .txt)"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap"
                  >
                    <UserPlus className="h-4 w-4 text-blue-700" />
                    <span className="hidden sm:inline">Studenti</span>
                  </button>

                  <button
                    type="button"
                    disabled={db.classes.length < 2 || activeClass.students.length === 0}
                    onClick={() => {
                      setMoveCopyStudentId(null);
                      setMoveCopyOpen(true);
                    }}
                    title={
                      db.classes.length < 2
                        ? 'Crea almeno due classi per spostare o copiare studenti'
                        : 'Sposta o copia uno studente in un’altra classe'
                    }
                    aria-label="Sposta o copia studente"
                    className="inline-flex h-9 min-w-[36px] items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap lg:px-2.5"
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                    <span className="hidden xl:inline">Sposta/Copia</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openEditClassModal(activeClass)}
                    title={`Minimi classe ${activeClass.name}: Grafici ${activeClass.minimums.COMPITO_GRAFICO}, Orali ${activeClass.minimums.INTERROGAZIONE_ORALE}, Pratici ${activeClass.minimums.CONSEGNA_PRATICO}`}
                    aria-label="Impostazioni classe e minimi"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Settings2 className="h-4 w-4" />
                    <span className="font-mono text-[11px] tabular-nums">
                      {activeClass.minimums.COMPITO_GRAFICO}/
                      {activeClass.minimums.INTERROGAZIONE_ORALE}/
                      {activeClass.minimums.CONSEGNA_PRATICO}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      exportClassToExcel(activeClass);
                      showToast(`Classe ${activeClass.name} esportata in Excel.`);
                    }}
                    title={`Esporta tabella classe ${activeClass.name} in Excel (.xlsx)`}
                    aria-label="Esporta classe in Excel"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-emerald-700 transition-colors hover:bg-slate-50 lg:w-auto lg:gap-1.5 lg:px-2.5"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    <span className="hidden text-xs font-medium text-slate-700 lg:inline">
                      Excel
                    </span>
                  </button>
                </div>
              </div>

              {/* Register Table filling all remaining viewport height */}
              <RegisterTable
                schoolClass={activeClass}
                searchQuery={searchQuery}
                categoryFilter={categoryFilter}
                requirementFilter={requirementFilter}
                onUpdateStatus={handleUpdateStatus}
                onBulkSetActivityStatus={handleBulkSetActivityStatus}
                onEditActivity={(act) => {
                  setEditingActivity(act);
                  setActivityModalOpen(true);
                }}
                onRequestDeleteActivity={handleRequestDeleteActivity}
                onOpenStudentHistory={(stu) => setHistoryStudentId(stu.id)}
                onOpenMoveCopyStudent={(stuId) => {
                  setMoveCopyStudentId(stuId);
                  setMoveCopyOpen(true);
                }}
                onAddActivity={() => {
                  setEditingActivity(null);
                  setActivityModalOpen(true);
                }}
                onAddStudent={() => {
                  setStudentModalTab('manual');
                  setStudentModalOpen(true);
                }}
              />
            </>
          )}
        </main>
      )}

      {view === 'resoconto' && (
        <ResocontoView
          classes={db.classes}
          onOpenClass={handleOpenClassFromView}
        />
      )}

      {view === 'archivio' && (
        <ArchiveSettingsView
          db={db}
          onEditClass={openEditClassModal}
          onRequestDeleteClass={handleRequestDeleteClass}
          onOpenClass={handleOpenClassFromView}
          onRestoreBackup={handleRestoreBackup}
        />
      )}

      {/* Modals */}
      <ActivityModal
        open={activityModalOpen}
        classNameLabel={activeClass?.name || ''}
        editingActivity={editingActivity}
        onSave={handleSaveActivity}
        onRequestDelete={handleRequestDeleteActivity}
        onClose={() => {
          setActivityModalOpen(false);
          setEditingActivity(null);
        }}
      />

      <StudentModal
        open={studentModalOpen}
        initialTab={studentModalTab}
        schoolClass={activeClass}
        onAddStudents={handleAddStudents}
        onClose={() => setStudentModalOpen(false)}
      />

      <ClassSettingsModal
        open={classModalOpen}
        mode={classModalMode}
        schoolClass={editingClassTarget}
        existingClassNames={db.classes.map((c) => c.name)}
        onSave={handleSaveClassSettings}
        onRequestDelete={handleRequestDeleteClass}
        onClose={() => {
          setClassModalOpen(false);
          setEditingClassTarget(null);
        }}
      />

      <MoveCopyStudentModal
        open={moveCopyOpen}
        sourceClass={activeClass}
        allClasses={db.classes}
        initialStudentId={moveCopyStudentId}
        onConfirm={handleMoveCopyStudent}
        onClose={() => {
          setMoveCopyOpen(false);
          setMoveCopyStudentId(null);
        }}
      />

      <StudentHistoryModal
        open={Boolean(historyStudent)}
        student={historyStudent}
        schoolClass={activeClass}
        onUpdateStudent={handleUpdateStudent}
        onOpenMoveCopy={(stuId) => {
          setMoveCopyStudentId(stuId);
          setMoveCopyOpen(true);
        }}
        onRequestDeleteStudent={handleRequestDeleteStudent}
        onDeleteArchivedEntry={handleDeleteArchivedEntry}
        onClose={() => setHistoryStudentId(null)}
      />

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState?.title || ''}
        description={confirmState?.description || ''}
        confirmLabel={confirmState?.confirmLabel}
        variant={confirmState?.variant}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />

      <PWAStatusOverlay />

      {/* Compact feedback toast */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="no-print fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3.5 py-2 text-xs font-medium text-white shadow-lg"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
