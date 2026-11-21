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

/** The writable parts of a name and an organization (People API, Name and Organization); the rest is Google's own. */
const NAME_FIELDS = [
  'givenName',
  'familyName',
  'middleName',
  'honorificPrefix',
  'honorificSuffix',
  'phoneticFullName',
  'phoneticFamilyName',
  'phoneticGivenName',
  'phoneticMiddleName',
  'phoneticHonorificPrefix',
  'phoneticHonorificSuffix',
] as const;
const ORGANIZATION_FIELDS = [
  'type',
  'startDate',
  'endDate',
  'current',
  'name',
  'phoneticName',
  'department',
  'title',
  'jobDescription',
  'symbol',
  'domain',
  'location',
  'costCenter',
  'fullTimeEquivalentMillipercent',
] as const;
const ENTRY_FIELDS = ['value', 'type'] as const;

function writable(value: unknown, fields: readonly string[]): Json {
  const entry = obj(value);
  return Object.fromEntries(fields.filter(field => entry[field] !== undefined).map(field => [field, entry[field]]));
}

/**
 * The contact's own entries as they can be sent back: every writable part of every name, organization, address and
 * number. Google replaces a whole field the mask names, so a change starts from these and sets only what is given.
 * `unstructuredName` is left out: Google makes it from the parts, and an old one would win over a changed part.
 */
interface Current {
  names: Json[];
  organizations: Json[];
  emailAddresses: Json[];
  phoneNumbers: Json[];
}

function currentOf(person: Json): Current {
  return {
    names: arr(person.names).map(n => writable(n, NAME_FIELDS)),
    organizations: arr(person.organizations).map(o => writable(o, ORGANIZATION_FIELDS)),
    emailAddresses: arr(person.emailAddresses).map(e => writable(e, ENTRY_FIELDS)),
    phoneNumbers: arr(person.phoneNumbers).map(e => writable(e, ENTRY_FIELDS)),
  };
}

const EMPTY: Current = { names: [], organizations: [], emailAddresses: [], phoneNumbers: [] };

/** The given values as entries, each keeping the label (work, home, ...) an entry with the same value has today. */
function entries(values: string[], current: Json[]): Json[] {
  return values.map(value => {
    const same = current.find(entry => entry.value === value);
    return same?.type !== undefined ? { value, type: same.type } : { value };
  });
}

/**
 * The person body and the field masks it sets. Google replaces a whole field the mask names, so the first name and the
 * first organization are changed in place, with every other part and every other name or organization kept as the
 * contact has them (`current`).
 */
function personBody(fields: ContactFields, current: Current = EMPTY): { body: Json; masks: string[] } {
  const body: Json = {};
  const masks: string[] = [];
  if (fields.givenName !== undefined || fields.familyName !== undefined) {
    const [first = {}, ...rest] = current.names;
    const name: Json = { ...first };
    if (fields.givenName !== undefined) name.givenName = fields.givenName;
    if (fields.familyName !== undefined) name.familyName = fields.familyName;
    body.names = [name, ...rest];
    masks.push('names');
  }
  if (fields.emails !== undefined) {
    body.emailAddresses = entries(fields.emails, current.emailAddresses);
    masks.push('emailAddresses');
  }
  if (fields.phones !== undefined) {
    body.phoneNumbers = entries(fields.phones, current.phoneNumbers);
    masks.push('phoneNumbers');
  }
  if (fields.organization !== undefined) {
    const [first = {}, ...rest] = current.organizations;
    const organization: Json = { ...first };
    if (fields.organization.name !== undefined) organization.name = fields.organization.name;
    if (fields.organization.title !== undefined) organization.title = fields.organization.title;
    body.organizations = [organization, ...rest];
    masks.push('organizations');
  }
  return { body, masks };
}

export async function createContact(client: UpstreamClient, input: ContactFields): Promise<unknown> {
  const { body } = personBody(input);
  return shapePerson(await client.post('people', '/people:createContact', body, { personFields: PERSON_FIELDS }));
}

const MASK_TO_BEFORE: Record<string, string> = {
  names: 'names',
  emailAddresses: 'emails',
  phoneNumbers: 'phones',
  organizations: 'organizations',
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
  const updated = await client.patch(
    'people',
    `${path}:updateContact`,
    { ...body, etag: current.etag, metadata: { sources } },
    { updatePersonFields: masks.join(','), personFields: PERSON_FIELDS },
  );
  // The values before, whole: every writable part of each field the change replaced, so it can be put back.
  const was = currentOf(current);
  return { contact: shapePerson(updated), before: Object.fromEntries(masks.map(mask => [MASK_TO_BEFORE[mask], was[mask as keyof Current]])) };
}
