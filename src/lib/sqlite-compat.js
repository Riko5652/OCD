// Thin compatibility wrapper: sql.js with a better-sqlite3-like synchronous API
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

let SQL = null;

/**
 * Must be called once before any openDatabase() call.
 * Loads the sql.js WASM binary.
 */
export async function initSqlite() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
}

/**
 * Opens (or creates) a SQLite database file with a better-sqlite3-compatible API.
 *
 * @param {string} filePath - Path to the .db file
 * @param {object} [opts]
 * @param {boolean} [opts.fileMustExist=false] - Throw if file doesn't exist
 * @param {boolean} [opts.readonly=false] - Open read-only (skip auto-save)
 * @returns {object} Database handle with .prepare(), .exec(), .pragma(), .transaction(), .close()
 */
export function openDatabase(filePath, opts = {}) {
  if (!SQL) throw new Error('sql.js not initialised — call initSqlite() first');

  const { fileMustExist = false, readonly = false } = opts;

  let db;
  if (filePath && existsSync(filePath)) {
    const buf = readFileSync(filePath);
    db = new SQL.Database(buf);
  } else if (fileMustExist) {
    throw new Error(`Database file not found: ${filePath}`);
  } else {
    db = new SQL.Database();
  }

  // Track whether we're inside a transaction to suppress per-statement saves
  let inTransaction = false;

  function save() {
    if (readonly || !filePath || inTransaction) return;
    const data = db.export();
    writeFileSync(filePath, Buffer.from(data));
  }

  /**
   * Normalise params: better-sqlite3 supports named (@/$/: prefixed) objects and positional args.
   * sql.js bind() accepts either an array (positional) or an object with $key/:key/@key keys.
   * However sql.js only recognises $key and :key — we normalise @key to $key.
   */
  function normaliseParams(params) {
    if (params.length === 0) return undefined;
    if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])) {
      const obj = params[0];
      const bound = {};
      for (const [key, value] of Object.entries(obj)) {
        // sql.js recognises $key and :key. better-sqlite3 uses @key in SQL.
        // Normalise: bare key -> $key, @key -> $key
        let k = key;
        if (/^@/.test(k)) k = '$' + k.slice(1);
        else if (!/^[:$]/.test(k)) k = '$' + k;
        bound[k] = value ?? null;
      }
      return bound;
    }
    // Positional
    return params.map(v => v ?? null);
  }

  /** Run a SQL statement via db.exec (which supports bind params as 2nd arg in sql.js) */

  const handle = {
    prepare(sql) {
      // Rewrite @param to $param in the SQL text so sql.js can match them
      const rewrittenSql = sql.replace(/@(\w+)/g, '$$$1');

      return {
        all(...params) {
          const bound = normaliseParams(params);
          const result = db.exec(rewrittenSql, bound);
          if (!result || result.length === 0) return [];
          const rows = [];
          for (const { columns, values } of result) {
            for (const row of values) {
              const obj = {};
              for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
              rows.push(obj);
            }
          }
          return rows;
        },
        get(...params) {
          const rows = this.all(...params);
          return rows.length > 0 ? rows[0] : undefined;
        },
        run(...params) {
          const bound = normaliseParams(params);
          db.run(rewrittenSql, bound);
          const changes = db.getRowsModified();
          save();
          // Fetch last_insert_rowid synchronously
          const idResult = db.exec('SELECT last_insert_rowid() as id');
          const lastId = idResult.length > 0 && idResult[0].values.length > 0
            ? idResult[0].values[0][0] : 0;
          return { changes, lastInsertRowid: BigInt(lastId) };
        },
      };
    },

    exec(sql) {
      db.run(sql);
      save();
    },

    pragma(str) {
      // better-sqlite3's pragma('journal_mode = WAL') is equivalent to PRAGMA journal_mode = WAL
      try {
        db.run(`PRAGMA ${str}`);
      } catch (_) {
        // Some PRAGMAs (e.g. WAL) are not meaningful for in-memory/file-flush dbs — ignore
      }
    },

    transaction(fn) {
      return (...args) => {
        db.run('BEGIN');
        inTransaction = true;
        try {
          const result = fn(...args);
          db.run('COMMIT');
          inTransaction = false;
          save();
          return result;
        } catch (e) {
          try { db.run('ROLLBACK'); } catch (_) { /* already rolled back */ }
          inTransaction = false;
          throw e;
        }
      };
    },

    close() {
      db.close();
    },
  };

  return handle;
}
