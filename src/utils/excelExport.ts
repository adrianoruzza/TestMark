import * as XLSX from 'xlsx';
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  STATUS_META,
  SchoolClass,
} from '../types';
import {
  StudentEvaluation,
  evaluateStudent,
  formatFullDate,
  getStudentStatus,
  sortActivitiesChronologically,
  sortStudentsAlphabetically,
} from './calculations';

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim() || 'Classe';
  return cleaned.slice(0, 31);
}

function buildClassWorksheet(schoolClass: SchoolClass): XLSX.WorkSheet {
  const sortedActivities = sortActivitiesChronologically(schoolClass.activities);
  const sortedStudents = sortStudentsAlphabetically(schoolClass.students);

  const headerRow1 = [
    'N.',
    'Cognome',
    'Nome',
    ...sortedActivities.map(
      (a) => `${a.title} (${CATEGORY_META[a.category].shortLabel} - ${formatFullDate(a.date)})`
    ),
    `Compiti grafici (min ${schoolClass.minimums.COMPITO_GRAFICO})`,
    `Interrogazioni orali (min ${schoolClass.minimums.INTERROGAZIONE_ORALE})`,
    `Consegne pratiche (min ${schoolClass.minimums.CONSEGNA_PRATICO})`,
    'Assenze',
    'Non svolti',
    'Situazione',
    'Carenze',
  ];

  const dataRows = sortedStudents.map((student, idx) => {
    const evalResult = evaluateStudent(student, schoolClass);
    return [
      idx + 1,
      student.lastName,
      student.firstName,
      ...sortedActivities.map((act) => {
        const status = getStudentStatus(student, act.id);
        return status === 'PENDENTE' ? '' : STATUS_META[status].label;
      }),
      `${evalResult.byCategory.COMPITO_GRAFICO.completedTotal}/${evalResult.byCategory.COMPITO_GRAFICO.minimum}`,
      `${evalResult.byCategory.INTERROGAZIONE_ORALE.completedTotal}/${evalResult.byCategory.INTERROGAZIONE_ORALE.minimum}`,
      `${evalResult.byCategory.CONSEGNA_PRATICO.completedTotal}/${evalResult.byCategory.CONSEGNA_PRATICO.minimum}`,
      evalResult.totalAbsent,
      evalResult.totalNotDone,
      evalResult.allRequirementsMet ? 'IN REGOLA' : 'CARENZA',
      evalResult.allRequirementsMet ? '' : evalResult.deficitSummary,
    ];
  });

  const sheet = XLSX.utils.aoa_to_sheet([headerRow1, ...dataRows]);

  sheet['!cols'] = [
    { wch: 5 },
    { wch: 18 },
    { wch: 16 },
    ...sortedActivities.map(() => ({ wch: 20 })),
    { wch: 18 },
    { wch: 20 },
    { wch: 20 },
    { wch: 10 },
    { wch: 12 },
    { wch: 14 },
    { wch: 32 },
  ];

  return sheet;
}

function buildReportWorksheet(evaluations: StudentEvaluation[]): XLSX.WorkSheet {
  const headers = [
    'Classe',
    'Cognome',
    'Nome',
    'Compiti grafici',
    'Stato Grafici',
    'Interrogazioni orali',
    'Stato Orali',
    'Consegne pratiche',
    'Stato Pratici',
    'Assenze da recuperare',
    'Non svolti',
    'Situazione complessiva',
    'Dettaglio carenze',
  ];

  const rows = evaluations.map((ev) => [
    ev.schoolClass.name,
    ev.student.lastName,
    ev.student.firstName,
    `${ev.byCategory.COMPITO_GRAFICO.completedTotal}/${ev.byCategory.COMPITO_GRAFICO.minimum}`,
    ev.byCategory.COMPITO_GRAFICO.met ? 'OK' : 'DA RECUPERARE',
    `${ev.byCategory.INTERROGAZIONE_ORALE.completedTotal}/${ev.byCategory.INTERROGAZIONE_ORALE.minimum}`,
    ev.byCategory.INTERROGAZIONE_ORALE.met ? 'OK' : 'DA RECUPERARE',
    `${ev.byCategory.CONSEGNA_PRATICO.completedTotal}/${ev.byCategory.CONSEGNA_PRATICO.minimum}`,
    ev.byCategory.CONSEGNA_PRATICO.met ? 'OK' : 'DA RECUPERARE',
    ev.totalAbsent,
    ev.totalNotDone,
    ev.allRequirementsMet ? 'IN REGOLA' : 'CARENZA',
    ev.allRequirementsMet ? '' : ev.deficitSummary,
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = [
    { wch: 10 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 15 },
    { wch: 18 },
    { wch: 15 },
    { wch: 18 },
    { wch: 15 },
    { wch: 18 },
    { wch: 12 },
    { wch: 20 },
    { wch: 36 },
  ];
  return sheet;
}

export function exportClassToExcel(schoolClass: SchoolClass): void {
  const wb = XLSX.utils.book_new();
  const ws = buildClassWorksheet(schoolClass);
  XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(`Classe ${schoolClass.name}`));
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeName = schoolClass.name.replace(/\s+/g, '_');
  XLSX.writeFile(wb, `registro-classe-${safeName}-${dateStr}.xlsx`);
}

export function exportAllClassesToExcel(classes: SchoolClass[]): void {
  const wb = XLSX.utils.book_new();
  const allEvals: StudentEvaluation[] = [];

  for (const cls of classes) {
    for (const stu of sortStudentsAlphabetically(cls.students)) {
      allEvals.push(evaluateStudent(stu, cls));
    }
  }

  XLSX.utils.book_append_sheet(wb, buildReportWorksheet(allEvals), 'Resoconto Generale');

  const usedNames = new Set<string>(['Resoconto Generale']);
  for (const cls of classes) {
    let base = sanitizeSheetName(`Classe ${cls.name}`);
    let counter = 2;
    while (usedNames.has(base)) {
      base = sanitizeSheetName(`Classe ${cls.name} (${counter})`);
      counter += 1;
    }
    usedNames.add(base);
    XLSX.utils.book_append_sheet(wb, buildClassWorksheet(cls), base);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `registro-prove-completo-${dateStr}.xlsx`);
}

export function exportResocontoToExcel(evaluations: StudentEvaluation[], label = 'resoconto'): void {
  const wb = XLSX.utils.book_new();
  const ws = buildReportWorksheet(evaluations);
  XLSX.utils.book_append_sheet(wb, ws, 'Resoconto Carenze');

  // Also add a summary sheet by category
  const total = evaluations.length;
  const okCount = evaluations.filter((e) => e.allRequirementsMet).length;
  const carenzeCount = total - okCount;

  const summaryRows = [
    ['Riepilogo Resoconto', 'Valore'],
    ['Studenti analizzati', total],
    ['Studenti in regola', okCount],
    ['Studenti con carenze', carenzeCount],
    ...CATEGORY_ORDER.map((cat) => [
      `Studenti carenti in ${CATEGORY_META[cat].pluralLabel}`,
      evaluations.filter((e) => !e.byCategory[cat].met).length,
    ]),
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [{ wch: 36 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Sintesi');

  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `registro-prove-${label}-${dateStr}.xlsx`);
}
