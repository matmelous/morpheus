import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let _db = null;

export function getDb() {
  if (_db) return _db;

  mkdirSync(dirname(config.sqliteDbPath), { recursive: true });

  _db = new Database(config.sqliteDbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  logger.info({ path: config.sqliteDbPath }, 'SQLite opened');
  return _db;
}

export function closeDb() {
  if (!_db) return;
  _db.close();
  _db = null;
}
