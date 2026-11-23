import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { Student } from '../types';
import { normalizeNameKey } from './calculations';

export type ImportFileType = 'xlsx' | 'docx' | 'txt';

export interface ParsedSheetData {
  name: string;
  rows: string[][];
}

export interface RawImportPayload {
  fileName: string;
  fileType: ImportFileType;
  sheets: ParsedSheetData[];
}

export interface PreviewStudentRow {
  rowId: string;
  lastName: string;
  firstName: string;
  selected: boolean;
  duplicateReason: 'existing' | 'in_file' | null;
  rawSource: string;
}

const SURNAME_PARTICLES = new Set([
  'de',
  'del',
  'della',
  'delle',
  'dello',
  'dei',
  'degli',
  'di',
  'da',
  'dal',
  'dalla',
  'dalle',
  'dallo',
  'la',
  'le',
  'lo',
  'li',
  'san',
  'santa',
  'santo',
  'van',
  'von',
  'mc',
  'mac',
]);

function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripListPrefix(line: string): string {
  return line
    .replace(/^\s*(?:n\.?\s*)?\d{1,3}\s*[).\-–:/]\s*/i, '')
    .replace(/^\s*[-•*▪◦]\s*/, '')
    .trim();
}

function toProperCase(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // If already mixed case (not all upper and not all lower), keep user's capitalization
  const isAllUpper = trimmed === trimmed.toUpperCase() && trimmed !== trimmed.toLowerCase();
  const isAllLower = trimmed === trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase();
  if (!isAllUpper && !isAllLower) return trimmed;

  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((word) =>
      word
        .split("'")
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ''))
        .join("'")
    )
    .join(' ');
}

export function splitFullName(
  rawText: string,
  order: 'cognome_nome' | 'nome_cognome'
): { lastName: string; firstName: string } {
  const cleaned = stripListPrefix(cleanCell(rawText));
  if (!cleaned) return { lastName: '', firstName: '' };

  // Explicit comma format: "Rossi, Mario"
  if (cleaned.includes(',')) {
    const [left, ...rest] = cleaned.split(',');
    const right = rest.join(' ').trim();
    if (order === 'cognome_nome') {
      return {
        lastName: toProperCase(left),
        firstName: toProperCase(right),
      };
    }
    return {
      firstName: toProperCase(left),
      lastName: toProperCase(right),
    };
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return {
      lastName: toProperCase(tokens[0]),
      firstName: '',
    };
  }

  if (order === 'cognome_nome') {
    // Handle multi-word Italian surnames like "De Luca Sofia" or "Del Vecchio Marco"
    let surnameCount = 1;
    if (tokens.length >= 3 && SURNAME_PARTICLES.has(tokens[0].toLowerCase())) {
      surnameCount = 2;
    }
    const lastName = tokens.slice(0, surnameCount).join(' ');
    const firstName = tokens.slice(surnameCount).join(' ');
    return {
      lastName: toProperCase(lastName),
      firstName: toProperCase(firstName),
    };
  } else {
    // "Sofia De Luca" -> firstName: Sofia, lastName: De Luca
    let surnameStart = tokens.length - 1;
    if (
      tokens.length >= 3 &&
      SURNAME_PARTICLES.has(tokens[tokens.length - 2].toLowerCase())
    ) {
      surnameStart = tokens.length - 2;
    }
    const firstName = tokens.slice(0, surnameStart).join(' ');
    const lastName = tokens.slice(surnameStart).join(' ');
    return {
      lastName: toProperCase(lastName),
      firstName: toProperCase(firstName),
    };
  }
}

export function looksLikeHeaderRow(row: string[]): boolean {
  const joined = row.join(' ').toLowerCase();
  const headerKeywords = [
    'cognome',
    'nome',
    'alunno',
    'alunni',
    'studente',
    'studenti',
    'nominativo',
    'nominativi',
    'elenco',
    'n.',
    'num',
    'classe',
  ];
  return headerKeywords.some((kw) => joined.includes(kw));
}

function parsePlainTextToGrid(text: string): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  // Detect tab or semicolon delimited rows
  const hasTabs = lines.some((l) => l.includes('\t'));
  const hasSemicolons = lines.some((l) => l.includes(';'));

  if (hasTabs) {
    return lines.map((l) => l.split('\t').map(cleanCell));
  }
  if (hasSemicolons) {
    return lines.map((l) => l.split(';').map(cleanCell));
  }

  return lines.map((l) => [cleanCell(l)]);
}

function parseHtmlTablesToGrid(html: string): string[][] {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  if (tables.length === 0) return [];

  const rows: string[][] = [];
  for (const table of tables) {
    const trs = Array.from(table.querySelectorAll('tr'));
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) =>
        cleanCell(cell.textContent || '')
      );
      if (cells.some((c) => c.length > 0)) {
        rows.push(cells);
      }
    }
  }
  return rows;
}

export async function parseStudentImportFile(file: File): Promise<RawImportPayload> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheets: ParsedSheetData[] = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: '',
        blankrows: false,
      });
      const rows = matrix
        .map((r) => (Array.isArray(r) ? r.map(cleanCell) : [cleanCell(r)]))
        .filter((r) => r.some((cell) => cell.length > 0));
      return { name, rows };
    }).filter((s) => s.rows.length > 0);

    if (sheets.length === 0) {
      throw new Error('Il file Excel non contiene righe leggibili.');
    }

    return {
      fileName: file.name,
      fileType: 'xlsx',
      sheets,
    };
  }

  if (lower.endsWith('.docx')) {
    const buffer = await file.arrayBuffer();
    const htmlResult = await mammoth.convertToHtml({ arrayBuffer: buffer });
    const tableRows = parseHtmlTablesToGrid(htmlResult.value);

    if (tableRows.length > 0) {
      return {
        fileName: file.name,
        fileType: 'docx',
        sheets: [{ name: 'Tabella Word', rows: tableRows }],
      };
    }

    const textResult = await mammoth.extractRawText({ arrayBuffer: buffer });
    const textRows = parsePlainTextToGrid(textResult.value);
    if (textRows.length === 0) {
      throw new Error('Il documento Word non contiene nominativi leggibili.');
    }

    return {
      fileName: file.name,
      fileType: 'docx',
      sheets: [{ name: 'Documento Word', rows: textRows }],
    };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.csv')) {
    const text = await file.text();
    const rows = parsePlainTextToGrid(text);
    if (rows.length === 0) {
      throw new Error('Il file di testo è vuoto.');
    }
    return {
      fileName: file.name,
      fileType: 'txt',
      sheets: [{ name: 'Elenco testo', rows }],
    };
  }

  throw new Error(
    'Formato file non supportato. Carica un file Excel (.xlsx), Word (.docx) o di testo (.txt).'
  );
}

export interface ExtractionConfig {
  mode: 'single_column' | 'two_columns';
  fullNameCol: number;
  lastNameCol: number;
  firstNameCol: number;
  hasHeaderRow: boolean;
  nameOrder: 'cognome_nome' | 'nome_cognome';
}

export function detectDefaultExtractionConfig(rows: string[][]): ExtractionConfig {
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 1);
  const firstRow = rows[0] || [];
  const hasHeader = looksLikeHeaderRow(firstRow);

  if (maxCols >= 2 && hasHeader) {
    const lowerHeaders = firstRow.map((h) => h.toLowerCase());
    const lastIdx = lowerHeaders.findIndex((h) => h.includes('cognome'));
    const firstIdx = lowerHeaders.findIndex(
      (h) => h.includes('nome') && !h.includes('cognome')
    );

    if (lastIdx !== -1 && firstIdx !== -1) {
      return {
        mode: 'two_columns',
        fullNameCol: lastIdx,
        lastNameCol: lastIdx,
        firstNameCol: firstIdx,
        hasHeaderRow: true,
        nameOrder: 'cognome_nome',
      };
    }

    const fullIdx = lowerHeaders.findIndex(
      (h) =>
        h.includes('nominativ') ||
        h.includes('studente') ||
        h.includes('alunn') ||
        h.includes('cognome')
    );
    if (fullIdx !== -1) {
      return {
        mode: 'single_column',
        fullNameCol: fullIdx,
        lastNameCol: fullIdx,
        firstNameCol: Math.min(fullIdx + 1, maxCols - 1),
        hasHeaderRow: true,
        nameOrder: 'cognome_nome',
      };
    }
  }

  // If 2+ columns and col 0 is purely numbers (1, 2, 3...), skip col 0
  const sampleRows = rows.slice(hasHeader ? 1 : 0, 6);
  const col0IsNumbers =
    maxCols >= 2 &&
    sampleRows.length > 0 &&
    sampleRows.every((r) => /^\d+[.)]?$/.test((r[0] || '').trim()));

  if (col0IsNumbers && maxCols >= 3) {
    return {
      mode: 'two_columns',
      fullNameCol: 1,
      lastNameCol: 1,
      firstNameCol: 2,
      hasHeaderRow: hasHeader,
      nameOrder: 'cognome_nome',
    };
  }

  if (col0IsNumbers) {
    return {
      mode: 'single_column',
      fullNameCol: 1,
      lastNameCol: 1,
      firstNameCol: 1,
      hasHeaderRow: hasHeader,
      nameOrder: 'cognome_nome',
    };
  }

  return {
    mode: 'single_column',
    fullNameCol: 0,
    lastNameCol: 0,
    firstNameCol: maxCols > 1 ? 1 : 0,
    hasHeaderRow: hasHeader,
    nameOrder: 'cognome_nome',
  };
}

export function buildPreviewRows(
  rows: string[][],
  config: ExtractionConfig,
  existingStudents: Student[]
): PreviewStudentRow[] {
  const startIdx = config.hasHeaderRow ? 1 : 0;
  const existingKeys = new Set(
    existingStudents.map((s) => normalizeNameKey(s.lastName, s.firstName))
  );
  const seenInFile = new Set<string>();
  const preview: PreviewStudentRow[] = [];

  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    let lastName = '';
    let firstName = '';
    let rawSource = '';

    if (config.mode === 'two_columns') {
      const rawLast = cleanCell(row[config.lastNameCol] ?? '');
      const rawFirst = cleanCell(row[config.firstNameCol] ?? '');
      rawSource = `${rawLast} ${rawFirst}`.trim();
      lastName = toProperCase(stripListPrefix(rawLast));
      firstName = toProperCase(rawFirst);
    } else {
      const raw = cleanCell(row[config.fullNameCol] ?? '');
      rawSource = raw;
      const split = splitFullName(raw, config.nameOrder);
      lastName = split.lastName;
      firstName = split.firstName;
    }

    if (!lastName && !firstName) continue;

    const key = normalizeNameKey(lastName, firstName);
    let duplicateReason: 'existing' | 'in_file' | null = null;
    if (existingKeys.has(key)) {
      duplicateReason = 'existing';
    } else if (seenInFile.has(key)) {
      duplicateReason = 'in_file';
    }
    seenInFile.add(key);

    preview.push({
      rowId: `imp_${i}`,
      lastName,
      firstName,
      selected: duplicateReason === null,
      duplicateReason,
      rawSource,
    });
  }

  return preview;
}

export function recomputePreviewDuplicates(
  rows: PreviewStudentRow[],
  existingStudents: Student[]
): PreviewStudentRow[] {
  const existingKeys = new Set(
    existingStudents.map((s) => normalizeNameKey(s.lastName, s.firstName))
  );
  const seen = new Set<string>();

  return rows.map((row) => {
    const key = normalizeNameKey(row.lastName, row.firstName);
    let duplicateReason: 'existing' | 'in_file' | null = null;
    if (key !== '|') {
      if (existingKeys.has(key)) {
        duplicateReason = 'existing';
      } else if (seen.has(key)) {
        duplicateReason = 'in_file';
      }
      seen.add(key);
    }
    return {
      ...row,
      duplicateReason,
    };
  });
}
