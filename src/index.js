import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { config, validateConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import routes from './routes/index.js';
import { applyMigrations } from './db/migrate.js';
import { ensureDefaultSettings } from './services/settings.js';
import { projectManager } from './services/project-manager.js';
import { startWhatsAppClient, stopWhatsAppClient } from './services/whatsapp.js';
import {
  startDiscordClient,
  stopDiscordClient,
  setInboundMessageHandler as setDiscordInboundMessageHandler,
} from './services/discord.js';
import { executor } from './services/executor.js';
import { processInboundMessage } from './services/inbound-core.js';
import { closeDb } from './db/index.js';

const app = express();

app.use(helmet());
app.use(cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(
      { status: res.statusCode, durationMs: Date.now() - start },
      `${req.method} ${req.originalUrl}`
    );
  });
  next();
});

app.use('/', routes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, _next) => {
  logger.error({ error: err?.message, stack: err?.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutdown requested');
  try { executor.stop(); } catch {}
  try { stopDiscordClient(); } catch {}
  try { stopWhatsAppClient(); } catch {}
  try { closeDb(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'Unhandled promise rejection'));
process.on('uncaughtException', (error) => logger.error({ error: error?.message, stack: error?.stack }, 'Uncaught exception'));

async function startServer() {
  validateConfig();

  applyMigrations();
  ensureDefaultSettings();

  projectManager.loadProjects();

  setDiscordInboundMessageHandler(async (payload) => {
    await processInboundMessage(payload);
  });

  executor.start();
  try {
    await startWhatsAppClient();
  } catch (err) {
    logger.error({ error: err?.message }, 'Failed to initialize WhatsApp standalone client');
  }
  if (config.discord.enabled) {
    try {
      await startDiscordClient();
    } catch (err) {
      logger.error({ error: err?.message }, 'Failed to initialize Discord client');
    }
  }

  const server = app.listen(config.port, async () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Morpheus standalone server started');

    logger.info({
      allowedPhones: config.allowedPhoneNumbers,
      admins: config.adminPhoneNumbers,
      discordEnabled: config.discord.enabled,
      discordGuilds: config.discord.allowedGuildIds,
    }, 'Ready');
  });

  server.on('error', (err) => {
    logger.error({ error: err?.message, code: err?.code }, 'Server listen failed');
    process.exit(1);
  });
}

startServer().catch((err) => {
  logger.error({ error: err?.message, stack: err?.stack }, 'Failed to start server');
  process.exit(1);
});

export default app;
