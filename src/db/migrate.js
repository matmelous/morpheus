import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getDb } from './index.js';

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);
}

export function applyMigrations() {
  const db = getDb();
  ensureMigrationsTable(db);

  const migrationsDir = resolve(config.appRoot, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations ORDER BY id').all().map((r) => r.filename)
  );

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const fullPath = resolve(migrationsDir, filename);
    const sql = readFileSync(fullPath, 'utf-8');

    const applyOne = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)')
        .run(filename, new Date().toISOString());
    });

    applyOne();
    logger.info({ filename }, 'Migration applied');
  }
}
