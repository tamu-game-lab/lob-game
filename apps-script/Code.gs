/*
 * LOB Game play-data receiver: a Google Apps Script web app (V8 runtime, no libraries).
 *
 * Contract: docs/data-dictionary.md, schema 1. The game posts batches of rows as
 * text/plain JSON. doPost validates a post, appends its rows to the tab for their mode
 * and kind (columns matched by header name; a new field gets a new column on the
 * right), stamps server_time, and replies with a small JSON object. doGet answers
 * ?op=health and ?op=code.
 *
 * Bound script: create it from the Google Sheet (Extensions > Apps Script), so that
 * SpreadsheetApp.getActiveSpreadsheet() is that Sheet. Steps: docs/apps-script-setup.md.
 *
 * Privacy: payload contents can be research data and are never logged. Logs carry
 * counts and error kinds only.
 *
 * Duplicates: an appended batch id is remembered in the script cache for 6 hours, the
 * CacheService maximum. A retry that arrives later than that, or after the cache
 * evicted the id early, is appended again; so is a retry after a failure that came
 * after some tabs were written. Every row carries session and row_seq, so analysis
 * can drop such duplicates.
 *
 * Offline tests: node apps-script/test/run-tests.js
 */

const SCRIPT_VERSION = 'lob-receiver 1.0.0 (2026-10-28)';
const SCHEMA = 1;

const MAX_BODY_BYTES = 200 * 1024; // "at most 200 KB per post", counted in UTF-8 bytes
const MAX_ROWS = 100;
const MAX_TEXT = 1000;
const MAX_DETAIL = 4000; // "detail" holds a telemetry line's key/value pairs as compact JSON
// Distinct row field names in one post. The four kinds together use 30; the cap only
// stops a malformed or hostile post from flooding a tab with columns.
const MAX_FIELDS = 64;

const LOCK_WAIT_MS = 20000;
const BATCH_TTL_S = 21600; // 6 h, the CacheService maximum
const CODES_TTL_S = 60;
const ROW_CHUNK = 1000; // a full tab grows by at least this many rows, so most appends skip the resize

const CODES_TAB = 'codes';
const UNMATCHED_TAB = 'unmatched';
const MODE_PREFIX = { study: '', tryout: 'tryout_', test: 'test_' };
const KIND_TAB = { session: 'sessions', progress: 'progress', run: 'runs', event: 'events' };
const BODY_FIELDS = ['schema', 'mode', 'build', 'code', 'session', 'batch', 'sent_at', 'rows'];
// The server sets these on every row (post-level values and server stamps), so a row may not carry them.
const RESERVED_ROW_FIELDS = ['schema', 'mode', 'build', 'code', 'session', 'server_time', 'target_tab'];

const CODE_RE = /^[A-Za-z]{1,3}[0-9]{1,4}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Web app POST: one batch of rows from the game.
 * Replies {"ok":true,"appended":N}, {"ok":true,"appended":0,"duplicate":true},
 * {"ok":false,"error":"<reason>","retry":false} for an invalid post, or
 * {"ok":false,"error":"busy"|"server","retry":true} when the client should try again later.
 */
function doPost(e) {
  let post;
  try {
    post = readPost_(e);
  } catch (err) {
    if (!err || !err.invalid) return serverError_('validate', err);
    console.warn('rejected: ' + err.reason);
    return reply_({ ok: false, error: err.message, retry: false });
  }
  try {
    return storePost_(post);
  } catch (err) {
    return serverError_('store', err);
  }
}

/** Web app GET: ?op=health, or ?op=code&code=P042 (answers for that one code; never lists codes). */
function doGet(e) {
  const params = (e && e.parameter) || {};
  try {
    if (params.op === 'health') {
      if (!SpreadsheetApp.getActiveSpreadsheet()) return reply_({ ok: false, error: 'not bound to a sheet' });
      return reply_({ ok: true, schema: SCHEMA, script: SCRIPT_VERSION, time: isoNow_() });
    }
    if (params.op === 'code') {
      const code = typeof params.code === 'string' ? params.code : '';
      const known = CODE_RE.test(code) && activeCodes_(spreadsheet_()).has(code.toUpperCase());
      return reply_({ ok: true, known: known });
    }
    return reply_({ ok: false, error: 'unknown op' });
  } catch (err) {
    return serverError_('get', err);
  }
}

/** Parses and validates a post. Throws invalid_() errors; returns the post with its code upper-cased. */
function readPost_(e) {
  const text = e && e.postData ? e.postData.contents : null;
  if (typeof text !== 'string' || text === '') throw invalid_('empty body');
  if (text.length > MAX_BODY_BYTES || utf8Length_(text) > MAX_BODY_BYTES) throw invalid_('body too large');
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw invalid_('bad json'); // the parser's message quotes the payload, so it is dropped
  }
  if (!isObject_(body)) throw invalid_('body is not an object');
  Object.keys(body).forEach(key => {
    if (BODY_FIELDS.indexOf(key) < 0) throw invalid_('unknown body field', FIELD_RE.test(key) ? key : '');
  });
  if (body.schema !== SCHEMA) throw invalid_('unknown schema');
  if (typeof body.mode !== 'string' || !own_(MODE_PREFIX, body.mode)) throw invalid_('bad mode');
  if (!isText_(body.build)) throw invalid_('bad build');
  // Checked before upper-casing, so letters outside A-Z can never turn into a valid code.
  if (typeof body.code !== 'string' || !CODE_RE.test(body.code)) throw invalid_('bad code');
  if (typeof body.session !== 'string' || !UUID_RE.test(body.session)) throw invalid_('bad session');
  if (typeof body.batch !== 'string' || !UUID_RE.test(body.batch)) throw invalid_('bad batch');
  if (body.sent_at !== undefined && body.sent_at !== null && !isText_(body.sent_at)) throw invalid_('bad sent_at');
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw invalid_('no rows');
  if (rows.length > MAX_ROWS) throw invalid_('too many rows');
  const names = new Set();
  rows.forEach((row, i) => checkRow_(row, 'row ' + (i + 1), names));
  if (names.size > MAX_FIELDS) throw invalid_('too many fields');
  return {
    schema: body.schema,
    mode: body.mode,
    build: body.build,
    code: body.code.toUpperCase(),
    session: body.session,
    batch: body.batch,
    rows: rows,
  };
}

/** Validates one row: kind, row_seq, client_time, then every field name and value. */
function checkRow_(row, where, names) {
  if (!isObject_(row)) throw invalid_('row is not an object', where);
  if (typeof row.kind !== 'string' || !own_(KIND_TAB, row.kind)) throw invalid_('bad kind', where);
  if (!Number.isSafeInteger(row.row_seq) || row.row_seq < 1) throw invalid_('bad row_seq', where);
  if (!isText_(row.client_time) || row.client_time === '') throw invalid_('bad client_time', where);
  Object.keys(row).forEach(name => {
    if (!FIELD_RE.test(name)) throw invalid_('bad field name', where);
    if (RESERVED_ROW_FIELDS.indexOf(name) >= 0) throw invalid_('reserved field', where + ', ' + name);
    checkValue_(row[name], name, where);
    names.add(name);
  });
}

/** A value is a string (up to 1000 chars; 4000 for detail), a finite number, a boolean, or null (empty). */
function checkValue_(value, name, where) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && isFinite(value)) return;
  if (typeof value === 'string') {
    if (value.length > (name === 'detail' ? MAX_DETAIL : MAX_TEXT)) throw invalid_('value too long', where + ', ' + name);
    return;
  }
  throw invalid_('bad value', where + ', ' + name);
}

/** Appends a validated post under the script lock, unless its batch was already appended. */
function storePost_(post) {
  const batchKey = 'batch:' + post.batch.toLowerCase();
  if (cacheGet_(batchKey) !== null) return duplicate_();

  const ss = spreadsheet_();
  // Only study mode checks the code; tryout and test take any well-formed code.
  const matched = post.mode !== 'study' || activeCodes_(ss).has(post.code);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    console.warn('busy: lock wait timed out');
    return reply_({ ok: false, error: 'busy', retry: true });
  }
  let tabCount;
  try {
    // A copy of this batch may have been appended while this request waited for the lock.
    if (cacheGet_(batchKey) !== null) return duplicate_();
    const tabs = groupRows_(post, matched, isoNow_());
    tabs.forEach((rows, tabName) => appendRows_(ss, tabName, rows));
    SpreadsheetApp.flush(); // commit the writes before the next request can take the lock
    cachePut_(batchKey, '1', BATCH_TTL_S);
    tabCount = tabs.size;
  } finally {
    lock.releaseLock();
  }
  console.log('appended rows=' + post.rows.length + ' tabs=' + tabCount + (matched ? '' : ' unmatched'));
  return reply_({ ok: true, appended: post.rows.length });
}

/**
 * Builds the sheet rows of a post, grouped by tab. Each row starts with the common
 * fields (kind, the post-level values copied from the body, row_seq, client_time,
 * server_time), then its own fields in arrival order; a new tab's header follows this
 * order. Unmatched study rows go to the unmatched tab, with target_tab naming the tab
 * they would have gone to.
 */
function groupRows_(post, matched, serverTime) {
  const tabs = new Map();
  post.rows.forEach(row => {
    const target = MODE_PREFIX[post.mode] + KIND_TAB[row.kind];
    const out = {
      kind: row.kind,
      schema: post.schema,
      mode: post.mode,
      build: post.build,
      code: post.code,
      session: post.session,
      row_seq: row.row_seq,
      client_time: row.client_time,
      server_time: serverTime,
    };
    if (!matched) out.target_tab = target;
    Object.keys(row).forEach(name => {
      if (!own_(out, name)) out[name] = row[name];
    });
    const tabName = matched ? target : UNMATCHED_TAB;
    if (!tabs.has(tabName)) tabs.set(tabName, []);
    tabs.get(tabName).push(out);
  });
  return tabs;
}

/**
 * Appends rows (objects keyed by field name) to one tab with a single setValues call.
 * Columns are matched by header name; a new field first gets a header cell on the
 * right. A missing or empty tab gets a header row in the rows' field order, which
 * groupRows_ makes the common fields first, then the others in arrival order.
 */
function appendRows_(ss, tabName, rows) {
  const sheet = ss.getSheetByName(tabName) || ss.insertSheet(tabName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim())
    : [];
  const header = existing.slice();
  const column = new Map();
  header.forEach((name, i) => {
    if (name !== '' && !column.has(name)) column.set(name, i);
  });
  rows.forEach(row => Object.keys(row).forEach(name => {
    if (!column.has(name)) {
      column.set(name, header.length);
      header.push(name);
    }
  }));

  const width = header.length;
  const maxCols = sheet.getMaxColumns();
  if (width > maxCols) sheet.insertColumnsAfter(maxCols, width - maxCols);
  if (width > existing.length) {
    sheet.getRange(1, existing.length + 1, 1, width - existing.length)
      .setValues([header.slice(existing.length).map(toCell_)]);
  }

  const first = Math.max(lastRow, 1) + 1; // row 1 is the header
  const last = first + rows.length - 1;
  const maxRows = sheet.getMaxRows();
  if (last > maxRows) sheet.insertRowsAfter(maxRows, Math.max(last - maxRows, ROW_CHUNK));
  const values = rows.map(row => {
    const line = new Array(width).fill('');
    Object.keys(row).forEach(name => {
      line[column.get(name)] = toCell_(row[name]);
    });
    return line;
  });
  sheet.getRange(first, 1, rows.length, width).setValues(values);
}

/** The active study codes, upper-case, cached for CODES_TTL_S seconds. */
function activeCodes_(ss) {
  const cached = cacheGet_('codes');
  if (cached !== null) return new Set(JSON.parse(cached));
  const codes = readActiveCodes_(ss);
  cachePut_('codes', JSON.stringify(codes), CODES_TTL_S);
  return new Set(codes);
}

/**
 * Reads the codes tab: columns "code" and "active", found by header name in row 1.
 * A code is active when its active cell is TRUE or blank. Any other value makes it
 * inactive, and so does a FALSE (or other) entry anywhere for the same code.
 */
function readActiveCodes_(ss) {
  const sheet = ss.getSheetByName(CODES_TAB);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const codeCol = header.indexOf('code');
  const activeCol = header.indexOf('active');
  if (codeCol < 0) return [];
  const active = new Map();
  values.slice(1).forEach(line => {
    const code = String(line[codeCol]).trim().toUpperCase();
    if (code === '') return;
    const on = activeCol < 0 || isActiveCell_(line[activeCol]);
    active.set(code, (active.has(code) ? active.get(code) : true) && on);
  });
  return Array.from(active.keys()).filter(code => active.get(code));
}

function isActiveCell_(value) {
  if (value === true || value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim().toUpperCase();
  return text === '' || text === 'TRUE';
}

/**
 * Strings are written with a leading apostrophe, which Sheets reads as "this is text"
 * and does not store: a value is never run as a formula ("=...") and never turned into
 * a number, date or boolean. Numbers and booleans keep their type; null is an empty cell.
 */
function toCell_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return "'" + value;
  return value;
}

function duplicate_() {
  console.log('duplicate batch');
  return reply_({ ok: true, appended: 0, duplicate: true });
}

function cacheGet_(key) {
  try {
    return CacheService.getScriptCache().get(key);
  } catch (err) {
    console.warn('cache get failed');
    return null;
  }
}

function cachePut_(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(key, value, seconds);
  } catch (err) {
    console.warn('cache put failed');
  }
}

function spreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('script is not bound to a spreadsheet');
  return ss;
}

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Unexpected failure: the client keeps the rows and tries again later. Service error
 * messages describe the failure, not the payload (JSON parse errors, which quote the
 * payload, never get here).
 */
function serverError_(stage, err) {
  const name = err && err.name ? err.name : 'Error';
  const message = err && err.message ? String(err.message).slice(0, 200) : '';
  console.error('server error (' + stage + '): ' + name + (message ? ': ' + message : ''));
  return reply_({ ok: false, error: 'server', retry: true });
}

/** A validation failure. The reply shows reason and place; the log shows the reason only. */
function invalid_(reason, where) {
  const err = new Error(where ? reason + ' (' + where + ')' : reason);
  err.invalid = true;
  err.reason = reason;
  return err;
}

function isObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText_(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT;
}

function own_(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isoNow_() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function utf8Length_(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      bytes += 4; // a surrogate pair is one 4-byte character
      i++;
    } else bytes += 3;
  }
  return bytes;
}
