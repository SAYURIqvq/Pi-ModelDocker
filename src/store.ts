import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PiModelDockerError, type ConfigDocument } from './contracts.js';
import { validateConfig } from './config.js';

export interface StoredConfig { revision: number; document: ConfigDocument }
/** Full-catalog commits are atomic; optimistic revisions prevent lost updates. */
export class SqliteStore {
  #db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { this.#db.close(); throw new PiModelDockerError('invalid_config', 'Database schema is newer than this library.'); }
    this.#db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (route_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, selected TEXT);
      INSERT OR IGNORE INTO state VALUES (1,0,NULL);
      PRAGMA user_version=1; COMMIT;`);
  }
  read(): StoredConfig {
    this.#db.exec('BEGIN;');
    try {
      const state = this.#db.prepare('SELECT revision, selected FROM state WHERE id=1').get() as { revision: number; selected: string | null };
      const providers = this.#db.prepare('SELECT body FROM providers ORDER BY rowid').all().map(row => JSON.parse(row.body as string));
      const models = this.#db.prepare('SELECT body FROM models ORDER BY rowid').all().map(row => JSON.parse(row.body as string));
      const document = validateConfig({ schemaVersion: 1, providers, models, selectedRouteId: state.selected });
      this.#db.exec('COMMIT;');
      return { revision: state.revision, document };
    } catch { this.#db.exec('ROLLBACK;'); throw new PiModelDockerError('invalid_config', 'Cannot read a valid configuration database.'); }
  }
  replace(value: unknown, expectedRevision?: number): number {
    const doc = validateConfig(value);
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const { revision } = this.#db.prepare('SELECT revision FROM state WHERE id=1').get() as { revision: number };
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new PiModelDockerError('conflict', 'Configuration changed; reload before saving.');
      this.#db.exec('DELETE FROM models; DELETE FROM providers;');
      const providerInsert = this.#db.prepare('INSERT INTO providers VALUES (?,?)');
      const modelInsert = this.#db.prepare('INSERT INTO models VALUES (?,?,?)');
      for (const p of doc.providers) providerInsert.run(p.id, JSON.stringify(p));
      for (const m of doc.models) modelInsert.run(m.routeId, m.providerId, JSON.stringify(m));
      this.#db.prepare('UPDATE state SET revision=?, selected=? WHERE id=1').run(revision + 1, doc.selectedRouteId);
      this.#db.exec('COMMIT;'); return revision + 1;
    } catch (error) {
      this.#db.exec('ROLLBACK;');
      if (error instanceof PiModelDockerError) throw error;
      throw new PiModelDockerError('invalid_config', 'Configuration could not be committed.');
    }
  }
  close(): void { this.#db.close(); }
}
