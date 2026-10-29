'use strict';
/*
 * In-memory stand-ins for the Apps Script services that Code.gs uses:
 * SpreadsheetApp, LockService, CacheService, ContentService, MailApp, ScriptApp,
 * Session and console.
 *
 * They copy the real behaviour the script relies on:
 * - insertSheet() makes a 1000 x 26 sheet, and getRange() outside the sheet throws,
 *   so the script has to grow a sheet itself;
 * - setValues() needs data exactly the size of the range;
 * - a string is read the way Sheets reads typed input: a leading apostrophe forces
 *   text and is not stored, "=..." becomes a formula, numeric text becomes a number,
 *   and TRUE/FALSE become booleans;
 * - cache entries expire on a clock the tests control, and a TTL over 6 h throws;
 * - MailApp.sendEmail takes the message object form ({to, subject, body}), refuses a
 *   body over 200 KB (a personal account's limit), and keeps what it would send; a time
 *   trigger runs every 1, 5, 10, 15 or 30 minutes or every 1, 2, 4, 6, 8 or 12 hours,
 *   and any other interval throws.
 */

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MimeType = Object.freeze({ JSON: 'application/json', TEXT: 'text/plain' });
// Placeholders on the reserved example.com domain: no real account or address.
const DEPLOYER = 'deployer@example.com'; // Session.getEffectiveUser().getEmail()
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/fake-sheet-id/edit';
const MAX_BODY_BYTES = 200 * 1024; // MailApp's email body limit on a personal (gmail.com) account

class FakeSpreadsheet {
  constructor() {
    this.sheets = [];
    this.writes = []; // one entry per setValues call
    this.reads = []; // one entry per getValues call
    this.formulas = []; // cells Sheets would have turned into formulas
    this.failOn = null; // name of a method that throws once, to simulate a service failure
  }

  fault(method) {
    if (this.failOn !== method) return;
    this.failOn = null;
    throw new Error('Exception: Service Spreadsheets failed while accessing document (simulated ' + method + ').');
  }

  getSheetByName(name) {
    this.fault('getSheetByName');
    return this.sheets.find(sheet => sheet.name === name) || null;
  }

  insertSheet(name) {
    this.fault('insertSheet');
    if (this.sheets.some(sheet => sheet.name === name)) {
      throw new Error('Exception: A sheet with the name "' + name + '" already exists. Please enter another name.');
    }
    const sheet = new FakeSheet(this, name, 1000, 26);
    this.sheets.push(sheet);
    return sheet;
  }

  getSheets() {
    return this.sheets.slice();
  }

  getUrl() {
    return SHEET_URL;
  }

  // Test helper.
  sheetNames() {
    return this.sheets.map(sheet => sheet.name);
  }
}

class FakeSheet {
  constructor(spreadsheet, name, maxRows, maxColumns) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.maxRows = maxRows;
    this.maxColumns = maxColumns;
    this.grid = []; // grid[row - 1][column - 1]; a missing or '' cell is empty
  }

  getName() {
    return this.name;
  }

  getMaxRows() {
    return this.maxRows;
  }

  getMaxColumns() {
    return this.maxColumns;
  }

  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) {
      if ((this.grid[r] || []).some(isFilled)) return r + 1;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.grid.forEach(line => (line || []).forEach((value, c) => {
      if (isFilled(value) && c + 1 > last) last = c + 1;
    }));
    return last;
  }

  insertRowsAfter(afterPosition, howMany) {
    checkPosition(afterPosition, this.maxRows, howMany);
    const blank = Array.from({ length: howMany }, () => []);
    if (afterPosition < this.grid.length) this.grid.splice(afterPosition, 0, ...blank);
    this.maxRows += howMany;
    return this;
  }

  insertColumnsAfter(afterPosition, howMany) {
    checkPosition(afterPosition, this.maxColumns, howMany);
    this.grid.forEach(line => {
      if (line && afterPosition < line.length) line.splice(afterPosition, 0, ...new Array(howMany).fill(''));
    });
    this.maxColumns += howMany;
    return this;
  }

  deleteRows(rowPosition, howMany) {
    this.spreadsheet.fault('deleteRows');
    checkPosition(rowPosition, this.maxRows, howMany);
    if (rowPosition + howMany - 1 > this.maxRows) throw new Error('Exception: Those rows are out of bounds.');
    if (howMany >= this.maxRows) throw new Error('Exception: Sorry, it is not possible to delete all non-frozen rows.');
    this.grid.splice(rowPosition - 1, howMany);
    this.maxRows -= howMany;
    return this;
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    if (![row, column, numRows, numColumns].every(Number.isInteger)) {
      throw new Error('Exception: Invalid argument.');
    }
    if (numRows < 1) throw new Error('Exception: The number of rows in the range must be at least 1.');
    if (numColumns < 1) throw new Error('Exception: The number of columns in the range must be at least 1.');
    if (row < 1 || column < 1 || row + numRows - 1 > this.maxRows || column + numColumns - 1 > this.maxColumns) {
      throw new Error('Exception: The coordinates of the range are outside the dimensions of the sheet.');
    }
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  appendRow(rowContents) {
    const row = this.getLastRow() + 1;
    this.maxRows = Math.max(this.maxRows, row);
    this.maxColumns = Math.max(this.maxColumns, rowContents.length);
    rowContents.forEach((value, c) => this.write(row, c + 1, value));
    return this;
  }

  write(row, column, value) {
    const stored = toStored(value, () => this.spreadsheet.formulas.push({ sheet: this.name, row, column }));
    while (this.grid.length < row) this.grid.push([]);
    if (!this.grid[row - 1]) this.grid[row - 1] = [];
    this.grid[row - 1][column - 1] = stored;
  }

  read(row, column) {
    const line = this.grid[row - 1];
    const value = line ? line[column - 1] : undefined;
    return value === undefined ? '' : value;
  }

  // Test helpers: row 1 as a list, and rows 2..last as objects keyed by header name.
  header() {
    const width = this.getLastColumn();
    return Array.from({ length: width }, (_, c) => this.read(1, c + 1));
  }

  records() {
    const header = this.header();
    const out = [];
    for (let r = 2; r <= this.getLastRow(); r++) {
      const record = {};
      header.forEach((name, c) => {
        record[name] = this.read(r, c + 1);
      });
      out.push(record);
    }
    return out;
  }
}

class FakeRange {
  constructor(sheet, row, column, numRows, numColumns) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getValues() {
    const spreadsheet = this.sheet.spreadsheet;
    spreadsheet.fault('getValues');
    spreadsheet.reads.push(this.describe());
    return Array.from({ length: this.numRows }, (_, i) =>
      Array.from({ length: this.numColumns }, (__, j) => this.sheet.read(this.row + i, this.column + j)));
  }

  setValues(values) {
    const spreadsheet = this.sheet.spreadsheet;
    spreadsheet.fault('setValues');
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error('Exception: The number of rows in the data does not match the number of rows in the range. ' +
        'The data has ' + (Array.isArray(values) ? values.length : 0) + ' but the range has ' + this.numRows + '.');
    }
    values.forEach(line => {
      if (!Array.isArray(line) || line.length !== this.numColumns) {
        throw new Error('Exception: The number of columns in the data does not match the number of columns in the range. ' +
          'The data has ' + (Array.isArray(line) ? line.length : 0) + ' but the range has ' + this.numColumns + '.');
      }
    });
    spreadsheet.writes.push(this.describe());
    values.forEach((line, i) => line.forEach((value, j) => this.sheet.write(this.row + i, this.column + j, value)));
    return this;
  }

  describe() {
    return { sheet: this.sheet.name, row: this.row, column: this.column, rows: this.numRows, columns: this.numColumns };
  }
}

class FakeCache {
  constructor(clock) {
    this.clock = clock;
    this.entries = new Map();
    this.puts = []; // { key, expirationInSeconds } per put
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.clock.now >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  put(key, value, expirationInSeconds = 600) {
    if (typeof key !== 'string' || key.length > 250) throw new Error('Exception: Invalid cache key.');
    if (typeof value !== 'string') throw new Error('Exception: Cache values must be strings.');
    if (value.length > 100 * 1024) throw new Error('Exception: Argument too large: value');
    if (!(expirationInSeconds >= 1 && expirationInSeconds <= 21600)) {
      throw new Error('Exception: The cache expiration must be between 1 and 21600 seconds.');
    }
    this.puts.push({ key, expirationInSeconds });
    this.entries.set(key, { value, expiresAt: this.clock.now + expirationInSeconds * 1000 });
  }

  remove(key) {
    this.entries.delete(key);
  }
}

class FakeLockService {
  constructor() {
    this.busy = false; // when true, waitLock times out
    this.held = false;
    this.waits = []; // timeout of each waitLock call
    this.releases = 0;
    this.onWait = null; // runs inside waitLock, to simulate another request getting there first
  }

  getScriptLock() {
    const service = this;
    return {
      waitLock(timeoutInMillis) {
        service.waits.push(timeoutInMillis);
        if (service.onWait) service.onWait();
        if (service.busy) throw new Error('Exception: Lock timeout: another process was holding the lock for too long.');
        service.held = true;
      },
      tryLock(timeoutInMillis) {
        try {
          this.waitLock(timeoutInMillis);
          return true;
        } catch (err) {
          return false;
        }
      },
      hasLock() {
        return service.held;
      },
      releaseLock() {
        service.held = false;
        service.releases += 1;
      },
    };
  }
}

class FakeTextOutput {
  constructor(content) {
    this.content = String(content);
    this.mimeType = MimeType.TEXT;
  }

  setMimeType(mimeType) {
    this.mimeType = mimeType;
    return this;
  }

  getMimeType() {
    return this.mimeType;
  }

  getContent() {
    return this.content;
  }
}

class FakeMailApp {
  constructor() {
    this.sent = []; // { to, subject, body } per email sent
    this.failWith = null; // a message: the next sendEmail throws it once, to simulate a mail failure
    this.onSend = null; // runs inside sendEmail, before it sends or fails
  }

  sendEmail(message) {
    if (this.onSend) this.onSend(message);
    if (this.failWith !== null) {
      const text = this.failWith;
      this.failWith = null;
      throw new Error('Exception: ' + text);
    }
    if (!message || typeof message.to !== 'string' || message.to === '' ||
      typeof message.subject !== 'string' || typeof message.body !== 'string') {
      throw new Error('Exception: Invalid argument: message');
    }
    if (Buffer.byteLength(message.body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error('Exception: The email body is too large (simulated: over 200 KB).');
    }
    this.sent.push({ to: message.to, subject: message.subject, body: message.body });
  }
}

class FakeTrigger {
  constructor(id, handler, every) {
    this.id = id;
    this.handler = handler;
    this.every = every; // "15 minutes" or "1 hours": the test's view of the schedule
  }

  getUniqueId() {
    return this.id;
  }

  getHandlerFunction() {
    return this.handler;
  }
}

class FakeScriptApp {
  constructor() {
    this.triggers = [];
    this.nextId = 1;
  }

  newTrigger(functionName) {
    const app = this;
    let every = null;
    const clock = {
      everyMinutes(n) {
        if ([1, 5, 10, 15, 30].indexOf(n) < 0) throw new Error('Exception: Invalid argument: everyMinutes');
        every = n + ' minutes';
        return clock;
      },
      everyHours(n) {
        if ([1, 2, 4, 6, 8, 12].indexOf(n) < 0) throw new Error('Exception: Invalid argument: everyHours');
        every = n + ' hours';
        return clock;
      },
      create() {
        if (every === null) throw new Error('Exception: The trigger needs a schedule.');
        const trigger = new FakeTrigger(String(app.nextId++), functionName, every);
        app.triggers.push(trigger);
        return trigger;
      },
    };
    return { timeBased: () => clock };
  }

  getProjectTriggers() {
    return this.triggers.slice();
  }

  deleteTrigger(trigger) {
    this.triggers = this.triggers.filter(t => t !== trigger);
  }
}

/** Fresh fakes for one test. options.unbound makes getActiveSpreadsheet() return null. */
function createServices(options = {}) {
  const clock = { now: Date.UTC(2026, 9, 28, 19, 0, 0) };
  const spreadsheet = new FakeSpreadsheet();
  const cache = new FakeCache(clock);
  const locks = new FakeLockService();
  const mail = new FakeMailApp();
  const scriptApp = new FakeScriptApp();
  const logs = [];
  const stats = { flushes: 0 };
  const capture = level => (...args) => {
    logs.push(level + ': ' + args.map(String).join(' '));
  };
  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (options.unbound ? null : spreadsheet),
      flush: () => {
        stats.flushes += 1;
      },
    },
    LockService: locks,
    CacheService: { getScriptCache: () => cache },
    ContentService: { MimeType, createTextOutput: (content = '') => new FakeTextOutput(content) },
    MailApp: mail,
    ScriptApp: scriptApp,
    Session: { getEffectiveUser: () => ({ getEmail: () => DEPLOYER }) },
    console: { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error') },
  };
  return { globals, spreadsheet, cache, locks, mail, scriptApp, logs, clock, stats };
}

function isFilled(value) {
  return value !== undefined && value !== '';
}

function checkPosition(afterPosition, max, howMany) {
  if (!Number.isInteger(afterPosition) || afterPosition < 1 || afterPosition > max) {
    throw new Error('Exception: Those rows or columns are out of bounds.');
  }
  if (!Number.isInteger(howMany) || howMany < 1) throw new Error('Exception: Invalid argument: howMany');
}

function toStored(value, onFormula) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    if (value[0] === "'") return value.slice(1);
    if (value[0] === '=') {
      onFormula();
      return value;
    }
    const trimmed = value.trim();
    if (NUMBER_TEXT.test(trimmed)) return Number(trimmed);
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toUpperCase() === 'TRUE';
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Exception: Invalid number for a cell.');
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  throw new Error('Exception: Cannot write a value of type ' + typeof value + ' to a cell.');
}

module.exports = { createServices, MimeType, DEPLOYER, SHEET_URL };
