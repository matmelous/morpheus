import express from 'express';
import webhookRouter from './webhook.js';
import { getWhatsAppClientStatus } from '../services/whatsapp.js';

const router = express.Router();

router.get('/health', (req, res) => {
  const whatsapp = getWhatsAppClientStatus();

  res.json({
    status: 'ok',
    service: 'morpheus',
    timestamp: new Date().toISOString(),
    whatsapp,
  });
});

router.use('/webhook', webhookRouter);

export default router;
