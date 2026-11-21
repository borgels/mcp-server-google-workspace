# Changelog

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
