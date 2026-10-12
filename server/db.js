import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, DEFAULT_CATEGORIES } from './schema.js';

function toParam(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toArgs(params) {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(toParam);
  if (params !== null && typeof params === 'object') {
    const named = {};
    for (const [key, value] of Object.entries(params)) named[key] = toParam(value);
    return [named];
  }
  return [toParam(params)];
}

/**
 * Thin synchronous wrapper around node:sqlite with statement caching and
 * nestable transactions. Because every call is synchronous, a transaction
 * callback runs start-to-finish without other requests interleaving.
 */
export class Database {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.statements = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      // Queries with IN (...) lists vary in shape, so keep the cache bounded.
      if (this.statements.size > 500) this.statements.clear();
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  get(sql, params) {
    const row = this.prepare(sql).get(...toArgs(params));
    return row ? { ...row } : undefined;
  }

  all(sql, params) {
    return this.prepare(sql).all(...toArgs(params)).map((row) => ({ ...row }));
  }

  run(sql, params) {
    const result = this.prepare(sql).run(...toArgs(params));
    return { changes: Number(result.changes), id: Number(result.lastInsertRowid) };
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  /** Runs `fn` atomically. `fn` must be synchronous. Nested calls use savepoints. */
  transaction(fn) {
    this.depth += 1;
    const savepoint = `sp${this.depth}`;
    this.raw.exec(this.depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      this.raw.exec(this.depth === 1 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.raw.exec(this.depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  close() {
    this.raw.close();
  }
}

export function openDatabase(file) {
  const db = new Database(file);
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.get('PRAGMA user_version');
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      if (i === 0) {
        for (const c of DEFAULT_CATEGORIES) {
          db.run('INSERT INTO categories (name, kind, icon, sort) VALUES (:name, :kind, :icon, :sort)', c);
        }
      }
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}
