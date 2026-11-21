import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';

/** Google Tasks API v1 (https://developers.google.com/workspace/tasks/reference/rest). Tasks are never deleted. */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function shapeTask(value: unknown): Json {
  const t = obj(value);
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    due: t.due,
    completed: t.completed,
    parent: t.parent,
    updated: t.updated,
    webViewLink: t.webViewLink,
  };
}

/** A due date as the API takes it: RFC 3339 at midnight UTC (Tasks keeps only the date). */
function dueOf(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export async function listTaskLists(client: UpstreamClient, input: { pageToken?: string }): Promise<unknown> {
  const answer = obj(await client.get('tasks', '/users/@me/lists', { maxResults: 100, pageToken: input.pageToken }));
  return {
    taskLists: arr(answer.items).map(l => ({ id: obj(l).id, title: obj(l).title, updated: obj(l).updated })),
    nextPageToken: answer.nextPageToken,
  };
}

export async function listTasks(
  client: UpstreamClient,
  input: { taskList?: string; showCompleted?: boolean; dueMin?: string; dueMax?: string; maxResults?: number; pageToken?: string },
): Promise<unknown> {
  const list = encodePathParam(input.taskList ?? '@default', 'taskList');
  const answer = obj(
    await client.get('tasks', `/lists/${list}/tasks`, {
      showCompleted: input.showCompleted ?? false,
      showHidden: input.showCompleted ?? false,
      dueMin: input.dueMin ? dueOf(input.dueMin) : undefined,
      dueMax: input.dueMax ? dueOf(input.dueMax) : undefined,
      maxResults: input.maxResults ?? 50,
      pageToken: input.pageToken,
    }),
  );
  return { tasks: arr(answer.items).map(shapeTask), nextPageToken: answer.nextPageToken };
}

export async function createTask(
  client: UpstreamClient,
  input: { taskList?: string; title: string; notes?: string; due?: string },
): Promise<unknown> {
  const list = encodePathParam(input.taskList ?? '@default', 'taskList');
  const body: Json = { title: input.title };
  if (input.notes !== undefined) body.notes = input.notes;
  if (input.due !== undefined) body.due = dueOf(input.due);
  return shapeTask(await client.post('tasks', `/lists/${list}/tasks`, body));
}

export async function updateTask(
  client: UpstreamClient,
  input: { taskList?: string; task: string; title?: string; notes?: string; due?: string; completed?: boolean },
): Promise<unknown> {
  const list = encodePathParam(input.taskList ?? '@default', 'taskList');
  const path = `/lists/${list}/tasks/${encodePathParam(input.task, 'task')}`;
  const body: Json = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.notes !== undefined) body.notes = input.notes;
  if (input.due !== undefined) body.due = dueOf(input.due);
  if (input.completed !== undefined) body.status = input.completed ? 'completed' : 'needsAction';
  if (Object.keys(body).length === 0) throw new Error('Give at least one field to change.');
  // The task as it was, so the change can be undone.
  const before = shapeTask(await client.get('tasks', path));
  const after = shapeTask(await client.patch('tasks', path, body));
  return { task: after, before: Object.fromEntries(Object.keys(body).map(key => [key, before[key]])) };
}
