import express from 'express';
import webhookRouter from './webhook.js';

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'morpheus',
    timestamp: new Date().toISOString(),
  });
});

router.use('/webhook', webhookRouter);

export default router;
