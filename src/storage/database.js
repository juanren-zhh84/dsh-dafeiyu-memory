import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryError } from '../contracts.js';
import { migrate, queryOne, SCHEMA_VERSION } from './migrations.js';
import { WriteQueue } from './write-queue.js';

export class MemoryDatabase {
  #database;
  #statements = new Map();
  #connection;
  #closing;
  #closed = false;

  static async open(path, { beforeMigrate } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    try {
      const currentVersion = queryOne(database, 'PRAGMA user_version').user_version;
      if (currentVersion > SCHEMA_VERSION) {
        throw memoryError('MEMORY_SCHEMA_TOO_NEW', 'Memory database schema is newer than this runtime');
      }
      const hasTables = queryOne(database, "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").count > 0;
      if (hasTables && currentVersion < SCHEMA_VERSION) {
        if (!beforeMigrate) throw memoryError('MEMORY_MIGRATION_BACKUP_REQUIRED', 'Back up the existing memory database before migration');
        await beforeMigrate({ database, path, currentVersion, targetVersion: SCHEMA_VERSION });
      }
      // Set auto_vacuum before creating tables; setting it on an empty database needs no VACUUM.
      database.exec('PRAGMA auto_vacuum = INCREMENTAL');
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('PRAGMA busy_timeout = 5000');
      migrate(database);
      // An existing NONE database needs VACUUM to rebuild the pointer map.
      if (queryOne(database, 'PRAGMA auto_vacuum').auto_vacuum !== 2) database.exec('VACUUM');
      return new MemoryDatabase(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  constructor(database) {
    this.#database = database;
    this.writeQueue = new WriteQueue();
    this.#connection = Object.freeze({
      prepare: (sql) => {
        if (!this.#statements.has(sql)) this.#statements.set(sql, this.#database.prepare(sql));
        return this.#statements.get(sql);
      },
      exec: (sql) => this.#database.exec(sql),
    });
  }

  #assertOpen() {
    if (this.#closed) throw memoryError('MEMORY_DATABASE_CLOSED', 'Memory database is closed');
  }

  read(fn) {
    this.#assertOpen();
    return fn(this.#connection);
  }

  write(fn) {
    if (this.#closing || this.#closed) return Promise.reject(memoryError('MEMORY_DATABASE_CLOSED', 'Memory database is closed'));
    return this.writeQueue.enqueue(() => this.transaction(fn));
  }

  transaction(fn) {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    let active = true;
    const assertActive = () => {
      if (!active) throw memoryError('MEMORY_TRANSACTION_FINISHED', 'Memory transaction scope has finished');
    };
    const scopedStatements = new Map();
    const connection = Object.freeze({
      exec: (sql) => { assertActive(); return this.#connection.exec(sql); },
      prepare: (sql) => {
        assertActive();
        if (!scopedStatements.has(sql)) {
          const statement = this.#connection.prepare(sql);
          scopedStatements.set(sql, new Proxy(statement, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              return typeof value === 'function'
                ? (...args) => { assertActive(); return value.apply(target, args); }
                : value;
            },
          }));
        }
        return scopedStatements.get(sql);
      },
    });
    try {
      const result = fn(connection);
      if (result != null && typeof result.then === 'function') {
        // Consume a rejected native Promise to avoid a second unhandled-rejection failure.
        if (result instanceof Promise) result.catch(() => {});
        throw memoryError('MEMORY_ASYNC_TRANSACTION', 'Memory transactions must return synchronously');
      }
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    } finally {
      active = false;
    }
  }

  checkpoint() {
    this.#assertOpen();
    return this.#connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  }

  close() {
    if (!this.#closing) {
      this.#closing = (async () => {
        await this.writeQueue.close();
        try { this.checkpoint(); } finally {
          for (const statement of this.#statements.values()) statement.close();
          this.#statements.clear();
          this.#database.close();
          this.#closed = true;
        }
      })();
    }
    return this.#closing;
  }
}
