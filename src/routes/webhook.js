import express from 'express';

import { logger } from '../utils/logger.js';
import { processWhatsAppPayload } from '../services/inbound-core.js';
import { setInboundMessageHandler } from '../services/whatsapp.js';

const router = express.Router();

setInboundMessageHandler(async (payload) => {
  await processWhatsAppPayload(payload);
});

router.post('/', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    await processWhatsAppPayload(req.body);
  } catch (err) {
    logger.error({ error: err?.message, stack: err?.stack }, 'Webhook processing failed');
  }
});

export default router;
