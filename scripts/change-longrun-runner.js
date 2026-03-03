#!/usr/bin/env node
/**
 * Script to change the runner for an active longrun session
 * Usage: node scripts/change-longrun-runner.js <project_id> <new_runner>
 */

import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { logger } from '../src/utils/logger.js';

const [projectIdPattern, newRunner] = process.argv.slice(2);

if (!projectIdPattern || !newRunner) {
  console.error('Usage: node scripts/change-longrun-runner.js <project_id_pattern> <new_runner>');
  console.error('Example: node scripts/change-longrun-runner.js argonav claude-cli');
  process.exit(1);
}

async function main() {
  // Apply migrations first to ensure longrun_sessions table exists
  logger.info('Applying database migrations...');
  applyMigrations();

  const db = getDb();

  // Find active longrun sessions matching the project pattern
  const sessions = db.prepare(`
    SELECT id, phone, task_id, project_id, status, preferred_runner, runner_priority, created_at
    FROM longrun_sessions
    WHERE (project_id LIKE ? OR project_id LIKE ?)
      AND status IN ('gathering', 'confirming', 'running', 'paused')
    ORDER BY created_at DESC
  `).all(`%${projectIdPattern}%`, `%argo-${projectIdPattern}%`);

  if (sessions.length === 0) {
    logger.warn({ projectIdPattern }, 'No active longrun sessions found');
    console.log('\n❌ Nenhuma sessão longrun ativa encontrada para o projeto:', projectIdPattern);
    process.exit(0);
  }

  console.log(`\n📋 Sessões longrun ativas encontradas (${sessions.length}):\n`);
  sessions.forEach((s, i) => {
    console.log(`${i + 1}. ID: ${s.id}`);
    console.log(`   Projeto: ${s.project_id}`);
    console.log(`   Status: ${s.status}`);
    console.log(`   Runner atual: ${s.preferred_runner || 'padrão (priority: ' + s.runner_priority + ')'}`);
    console.log(`   Task ID: ${s.task_id}`);
    console.log(`   Criada em: ${s.created_at}\n`);
  });

  // Update all matching sessions
  const updated = db.prepare(`
    UPDATE longrun_sessions
    SET preferred_runner = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const updateMany = db.transaction((sessionIds) => {
    for (const id of sessionIds) {
      updated.run(newRunner, id);
    }
  });

  updateMany(sessions.map(s => s.id));

  logger.info({ count: sessions.length, newRunner }, 'Longrun sessions updated');
  console.log(`\n✅ ${sessions.length} sessão(ões) atualizada(s) com sucesso!`);
  console.log(`   Novo runner: ${newRunner}\n`);

  // Show updated sessions
  const updatedSessions = db.prepare(`
    SELECT id, project_id, status, preferred_runner
    FROM longrun_sessions
    WHERE id IN (${sessions.map(() => '?').join(',')})
  `).all(...sessions.map(s => s.id));

  console.log('📊 Sessões após atualização:\n');
  updatedSessions.forEach((s, i) => {
    console.log(`${i + 1}. ${s.project_id} (${s.status}) → runner: ${s.preferred_runner}`);
  });
  console.log();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to change longrun runner');
  console.error('\n❌ Erro ao alterar runner:', err.message);
  process.exit(1);
});
