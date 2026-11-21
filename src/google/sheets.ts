import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { fileIdFrom } from './values.js';

/**
 * Google Sheets API v4 (https://developers.google.com/workspace/sheets/api/reference/rest). Values are always written
 * with valueInputOption=RAW: a text that starts with `=` is stored as text, never run as a formula, so a written
 * value cannot fetch data from elsewhere or send the sheet's contents anywhere.
 */

type Json = Record<string, unknown>;
type Cell = string | number | boolean | null;

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const MAX_CELLS = 10_000;

/** A cell as Google gives it: text, a number or a truth value. Anything else is not a cell and is left out (null). */
function cell(value: unknown): Cell {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

function rowsOf(value: unknown): Cell[][] {
  return arr(value).map(row => arr(row).map(cell));
}

function spreadsheetId(value: string): string {
  const id = fileIdFrom(value, 'spreadsheets');
  if (!id) throw new Error("Give the spreadsheet's id or its link on docs.google.com.");
  return encodePathParam(id, 'spreadsheet');
}

function rangePath(range: string): string {
  return encodePathParam(range, 'range');
}

function cellCount(rows: readonly (readonly Cell[])[]): number {
  return rows.reduce((total, row) => total + row.length, 0);
}

function checkCells(rows: readonly (readonly Cell[])[]): void {
  if (rows.length === 0 || rows.every(row => row.length === 0)) throw new Error('Give at least one value.');
  if (cellCount(rows) > MAX_CELLS) throw new Error(`At most ${MAX_CELLS} cells in one change.`);
}

export async function getSpreadsheet(client: UpstreamClient, input: { spreadsheet: string }): Promise<unknown> {
  const answer = obj(
    await client.get('sheets', `/spreadsheets/${spreadsheetId(input.spreadsheet)}`, {
      fields: 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
    }),
  );
  const properties = obj(answer.properties);
  return {
    spreadsheetId: answer.spreadsheetId,
    title: properties.title,
    locale: properties.locale,
    timeZone: properties.timeZone,
    url: answer.spreadsheetUrl,
    sheets: arr(answer.sheets).map(sheet => {
      const p = obj(obj(sheet).properties);
      const grid = obj(p.gridProperties);
      return { sheetId: p.sheetId, title: p.title, index: p.index, rowCount: grid.rowCount, columnCount: grid.columnCount };
    }),
  };
}

export async function readRange(
  client: UpstreamClient,
  input: { spreadsheet: string; range: string; maxRows?: number },
): Promise<unknown> {
  const answer = obj(
    await client.get('sheets', `/spreadsheets/${spreadsheetId(input.spreadsheet)}/values/${rangePath(input.range)}`, {
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  );
  const rows = rowsOf(answer.values);
  const maxRows = input.maxRows ?? 500;
  return {
    range: answer.range,
    values: rows.slice(0, maxRows),
    rowCount: rows.length,
    ...(rows.length > maxRows ? { truncated: true } : {}),
  };
}

export async function updateRange(
  client: UpstreamClient,
  input: { spreadsheet: string; range: string; values: Cell[][] },
): Promise<unknown> {
  checkCells(input.values);
  const path = `/spreadsheets/${spreadsheetId(input.spreadsheet)}/values/${rangePath(input.range)}`;
  // The values as they were, so the change can be undone.
  const before = obj(await client.get('sheets', path, { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' }));
  const answer = obj(
    await client.put('sheets', path, { range: input.range, majorDimension: 'ROWS', values: input.values }, { valueInputOption: 'RAW' }),
  );
  return {
    updatedRange: answer.updatedRange,
    updatedRows: answer.updatedRows,
    updatedCells: answer.updatedCells,
    before: { range: before.range, values: rowsOf(before.values) },
  };
}

export async function appendRows(
  client: UpstreamClient,
  input: { spreadsheet: string; range: string; rows: Cell[][] },
): Promise<unknown> {
  checkCells(input.rows);
  const answer = obj(
    await client.post(
      'sheets',
      `/spreadsheets/${spreadsheetId(input.spreadsheet)}/values/${rangePath(input.range)}:append`,
      { majorDimension: 'ROWS', values: input.rows },
      { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
    ),
  );
  const updates = obj(answer.updates);
  return { tableRange: answer.tableRange, updatedRange: updates.updatedRange, updatedRows: updates.updatedRows, updatedCells: updates.updatedCells };
}

export async function createSpreadsheet(
  client: UpstreamClient,
  input: { title: string; sheetTitles?: string[] },
): Promise<unknown> {
  const body: Json = { properties: { title: input.title } };
  if (input.sheetTitles && input.sheetTitles.length > 0) {
    body.sheets = input.sheetTitles.map(title => ({ properties: { title } }));
  }
  const answer = obj(await client.post('sheets', '/spreadsheets', body));
  return {
    spreadsheetId: answer.spreadsheetId,
    title: obj(answer.properties).title,
    url: answer.spreadsheetUrl,
    sheets: arr(answer.sheets).map(sheet => obj(obj(sheet).properties).title),
  };
}
