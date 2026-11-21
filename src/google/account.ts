import { SCOPES, type UpstreamClient } from './client.js';

/**
 * Which account the access is to (OpenID Connect userinfo, https://developers.google.com/identity/openid-connect/openid-connect)
 * and which parts of Google Workspace the account's consent covers (the scopes in the token answer: with granular
 * consent an account can leave some out).
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});

export const SERVICE_SCOPES: Record<string, readonly string[]> = {
  calendar: [SCOPES.calendarList, SCOPES.calendarEvents],
  sheets: [SCOPES.sheets],
  docs: [SCOPES.docs],
  contacts: [SCOPES.contacts],
  tasks: [SCOPES.tasks],
};

export async function checkConnection(client: UpstreamClient): Promise<unknown> {
  const info = obj(await client.get('userinfo', '/userinfo'));
  const granted = client.grantedScopes;
  return {
    account: {
      id: info.sub,
      email: info.email,
      // Present for a Google Workspace account: the company's domain.
      hostedDomain: info.hd,
    },
    services: granted
      ? Object.fromEntries(Object.entries(SERVICE_SCOPES).map(([service, scopes]) => [service, scopes.every(s => granted.includes(s))]))
      : undefined,
  };
}
