import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';
import { contactId } from './values.js';

/**
 * Google People API v1, the account's own contacts (https://developers.google.com/people/api/rest). Only names,
 * e-mail addresses, phone numbers and organizations are read or written; no birthdays, addresses, notes or photos.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations';

export function shapePerson(value: unknown): Json {
  const p = obj(value);
  const name = obj(arr(p.names)[0]);
  return {
    resourceName: p.resourceName,
    name: name.displayName,
    givenName: name.givenName,
    familyName: name.familyName,
    emails: arr(p.emailAddresses).map(e => obj(e).value).filter(v => typeof v === 'string'),
    phones: arr(p.phoneNumbers).map(e => obj(e).value).filter(v => typeof v === 'string'),
    organizations: arr(p.organizations).map(o => ({ name: obj(o).name, title: obj(o).title })),
  };
}

export async function listContacts(client: UpstreamClient, input: { pageSize?: number; pageToken?: string }): Promise<unknown> {
  const answer = obj(
    await client.get('people', '/people/me/connections', {
      personFields: PERSON_FIELDS,
      pageSize: input.pageSize ?? 50,
      pageToken: input.pageToken,
      sortOrder: 'LAST_MODIFIED_DESCENDING',
    }),
  );
  return { contacts: arr(answer.connections).map(shapePerson), totalItems: answer.totalItems, nextPageToken: answer.nextPageToken };
}

export async function searchContacts(client: UpstreamClient, input: { query: string; pageSize?: number }): Promise<unknown> {
  // Google asks for a warm-up request with an empty query before a search, so the search sees recent contacts.
  await client.get('people', '/people:searchContacts', { query: '', readMask: PERSON_FIELDS });
  const answer = obj(
    await client.get('people', '/people:searchContacts', { query: input.query, readMask: PERSON_FIELDS, pageSize: input.pageSize ?? 10 }),
  );
  return { contacts: arr(answer.results).map(r => shapePerson(obj(r).person)) };
}

export async function getContact(client: UpstreamClient, input: { contact: string }): Promise<unknown> {
  return shapePerson(await client.get('people', `/people/${encodePathParam(contactId(input.contact), 'contact')}`, { personFields: PERSON_FIELDS }));
}

export interface ContactFields {
  givenName?: string;
  familyName?: string;
  emails?: string[];
  phones?: string[];
  organization?: { name?: string; title?: string };
}

/** The current values a partial change keeps: the name and the first organization as the contact has them. */
interface Current {
  givenName?: string;
  familyName?: string;
  organization?: { name?: string; title?: string };
}

function currentOf(person: Json): Current {
  const name = obj(arr(person.names)[0]);
  const org = obj(arr(person.organizations)[0]);
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    givenName: text(name.givenName),
    familyName: text(name.familyName),
    organization: arr(person.organizations).length > 0 ? { name: text(org.name), title: text(org.title) } : undefined,
  };
}

/**
 * The person body and the field masks it sets. Google replaces a whole field the mask names, so a part of the name or
 * the organization that is not given keeps the value the contact has (`current`).
 */
function personBody(fields: ContactFields, current: Current = {}): { body: Json; masks: string[] } {
  const body: Json = {};
  const masks: string[] = [];
  if (fields.givenName !== undefined || fields.familyName !== undefined) {
    body.names = [{ givenName: fields.givenName ?? current.givenName ?? '', familyName: fields.familyName ?? current.familyName ?? '' }];
    masks.push('names');
  }
  if (fields.emails !== undefined) {
    body.emailAddresses = fields.emails.map(value => ({ value }));
    masks.push('emailAddresses');
  }
  if (fields.phones !== undefined) {
    body.phoneNumbers = fields.phones.map(value => ({ value }));
    masks.push('phoneNumbers');
  }
  if (fields.organization !== undefined) {
    body.organizations = [
      {
        name: fields.organization.name ?? current.organization?.name ?? '',
        title: fields.organization.title ?? current.organization?.title ?? '',
      },
    ];
    masks.push('organizations');
  }
  return { body, masks };
}

export async function createContact(client: UpstreamClient, input: ContactFields): Promise<unknown> {
  const { body } = personBody(input);
  return shapePerson(await client.post('people', '/people:createContact', body, { personFields: PERSON_FIELDS }));
}

const MASK_TO_FIELDS: Record<string, string[]> = {
  names: ['givenName', 'familyName'],
  emailAddresses: ['emails'],
  phoneNumbers: ['phones'],
  organizations: ['organizations'],
};

export async function updateContact(client: UpstreamClient, input: ContactFields & { contact: string }): Promise<unknown> {
  if (personBody(input).masks.length === 0) throw new Error('Give at least one field to change.');
  const path = `/people/${encodePathParam(contactId(input.contact), 'contact')}`;
  // The contact as it is: its etag and its contact source with that source's etag (updateContact requires both and
  // refuses a change to a version that is no longer the newest), and the fields, so the change can be undone.
  const current = obj(await client.get('people', path, { personFields: `${PERSON_FIELDS},metadata` }));
  const sources = arr(obj(current.metadata).sources)
    .map(obj)
    .filter(source => source.type === 'CONTACT' && typeof source.id === 'string' && typeof source.etag === 'string')
    .map(source => ({ type: source.type, id: source.id, etag: source.etag }));
  if (typeof current.etag !== 'string' || sources.length === 0) {
    throw new Error("Google did not give the contact's version; nothing was changed.");
  }
  const { body, masks } = personBody(input, currentOf(current));
  const before = shapePerson(current);
  const updated = await client.patch(
    'people',
    `${path}:updateContact`,
    { ...body, etag: current.etag, metadata: { sources } },
    { updatePersonFields: masks.join(','), personFields: PERSON_FIELDS },
  );
  const keys = masks.flatMap(mask => MASK_TO_FIELDS[mask] ?? []);
  return { contact: shapePerson(updated), before: Object.fromEntries(keys.map(key => [key, before[key]])) };
}
