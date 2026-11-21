import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { fileIdFrom } from './values.js';

/**
 * Google Docs API v1 (https://developers.google.com/workspace/docs/api/reference/rest). A document is read as plain
 * text; a change only adds text (insertText). Nothing is deleted or replaced.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function documentId(value: string): string {
  const id = fileIdFrom(value, 'document');
  if (!id) throw new Error("Give the document's id or its link on docs.google.com.");
  return encodePathParam(id, 'document');
}

/** The text of a list of structural elements: paragraphs, and the cells of tables, in order. */
export function textOf(content: unknown, depth = 0): string {
  if (depth > 8) return '';
  let text = '';
  for (const element of arr(content)) {
    const e = obj(element);
    if (e.paragraph) {
      for (const part of arr(obj(e.paragraph).elements)) {
        const run = obj(obj(part).textRun);
        if (typeof run.content === 'string') text += run.content;
      }
    } else if (e.table) {
      for (const row of arr(obj(e.table).tableRows)) {
        const cells = arr(obj(row).tableCells).map(cell => textOf(obj(cell).content, depth + 1).replace(/\n+$/, '').replace(/\n/g, ' '));
        text += `${cells.join('\t')}\n`;
      }
    } else if (e.tableOfContents) {
      text += textOf(obj(e.tableOfContents).content, depth + 1);
    }
  }
  return text;
}

export async function getDocument(client: UpstreamClient, input: { document: string; maxChars?: number }): Promise<unknown> {
  const answer = obj(await client.get('docs', `/documents/${documentId(input.document)}`));
  const text = textOf(obj(answer.body).content);
  const maxChars = input.maxChars ?? 50_000;
  return {
    documentId: answer.documentId,
    title: answer.title,
    revisionId: answer.revisionId,
    text: text.slice(0, maxChars),
    length: text.length,
    ...(text.length > maxChars ? { truncated: true } : {}),
  };
}

async function insertAtEnd(client: UpstreamClient, id: string, text: string): Promise<Json> {
  return obj(
    await client.post('docs', `/documents/${id}:batchUpdate`, {
      requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }],
    }),
  );
}

export async function appendText(client: UpstreamClient, input: { document: string; text: string }): Promise<unknown> {
  const id = documentId(input.document);
  const answer = await insertAtEnd(client, id, input.text);
  return { documentId: answer.documentId, revisionId: obj(answer.writeControl).requiredRevisionId, insertedChars: input.text.length };
}

export async function createDocument(client: UpstreamClient, input: { title: string; text?: string }): Promise<unknown> {
  const created = obj(await client.post('docs', '/documents', { title: input.title }));
  const id = typeof created.documentId === 'string' ? created.documentId : '';
  const result: Json = {
    documentId: created.documentId,
    title: created.title,
    url: id ? `https://docs.google.com/document/d/${id}/edit` : undefined,
  };
  if (input.text && id) {
    await insertAtEnd(client, encodePathParam(id, 'document'), input.text);
    result.insertedChars = input.text.length;
  }
  return result;
}
