# Changelog

## 0.5.0

- `google_create_event` and `google_update_event` take a time in the form the
  description shows: `2026-11-22T10:00` with `timeZone` (or with an offset,
  `2026-11-22T10:00+01:00`). Seconds are added before the time is sent, since
  the Calendar API refuses a time without them; `timeZone` is sent along as
  before. A whole-day event whose end is its start day is that one day (the
  end is sent as the day after).
- `google_create_spreadsheet` answers with `firstSheet`, the name of the first
  sheet. Google names a new sheet in the account's language (`Sheet1`, `Ark1`,
  ...), and the range examples no longer assume `Sheet1`.

## 0.4.1

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.4.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.4.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.3.0

- A redirect from a Google API or the token endpoint, which is never
  followed, now also gives its error result `failure: { httpStatus,
  requestId? }`, with the same checks as an HTTP error. The text is
  unchanged.

## 0.2.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error (the token endpoint included), the result has `failure: { httpStatus,
  requestId? }`, so a host can count failures by status without reading
  their text. `requestId` is the vendor's own id from a response header
  (`REQUEST_ID_HEADERS`), kept only when it is a hex id of 8 to 64
  characters (one run of hex digits, or groups of four or more joined by
  single hyphens, as in a UUID) and does not hold the shape of a personal
  number. It is checked again after redaction, so an id that shared a piece
  with the key is dropped. Never the body, the vendor's error code or
  message. The shared helpers are in `src/errors.ts` (`vendorRequestId`,
  `requestIdFrom`, `failureMetadata`).

## 0.1.0

First version, from the MCP server template with its embedding surface (`./gateway`).

- Tools for one Google account: Calendar (calendars, events: list, get, create, change), Sheets (spreadsheet, read
  and write a range, add rows, create), Docs (read as text, add text at the end, create), Contacts (list, search,
  create, change) and Tasks (lists, tasks: list, create, change or mark done). `check_connection` names the account
  and the parts of Workspace the consent covers.
- OAuth: the app's client id and secret and the account's refresh token; the access token is fetched from
  `oauth2.googleapis.com`, kept in memory, renewed a minute before it expires and once after a 401, and redacted
  with the other secrets. A new refresh token in a token answer is used and given to the host (`onRefreshToken`).
- No restricted scope: no Gmail and no Drive scope.
- Writes only from a fixed list (`ALLOWED_WRITES`); no DELETE. Calendar changes with `sendUpdates=none`; Sheets
  values as `RAW`. A change answers with the values before it.
- Answers are cut down to the fields a person reads; nothing else from Google is passed on.
- A contact change sends the contact source with its version, as Google requires, and keeps every part of the name
  and the organization that is not given, the other names and organizations, and the labels on kept addresses and
  numbers; only the contact's own data is read before a change (`READ_SOURCE_TYPE_CONTACT`), never the Google
  profile's; the values before are answered whole. A search sends Google's warm-up request first.
- A new access token or rotated refresh token from Google passes the same key admission as the host's secrets
  (no piece shared with the fixed texts, fallbacks or tool list); one that does not is never used.
- A range that holds formulas is not overwritten; the values before a change are read with formulas.
- A document is read with all its tabs. Calendar ids with `#` (Google's own calendars) are encoded as one segment.
