import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetMessengerAdaptersForTest,
  __setMessengerAdaptersForTest,
  parseDiscordActorId,
  sendAudio,
  sendFile,
  sendImage,
  sendMessage,
  upsertMessage,
} from './messenger.js';

test('messenger routes sendMessage by actorId', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    sendWhatsAppMessage: async (to, text) => { calls.push(['wa', to, text]); },
    sendDiscordMessage: async (channelId, text) => { calls.push(['dc', channelId, text]); },
  });

  await sendMessage('5511999999999', 'ola wa');
  await sendMessage('dc:123:456', 'ola dc');

  assert.deepEqual(calls, [
    ['wa', '5511999999999', 'ola wa'],
    ['dc', '456', 'ola dc'],
  ]);

  __resetMessengerAdaptersForTest();
});

test('messenger sendImage uses Discord image adapter', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    sendDiscordImage: async (channelId, payload) => { calls.push([channelId, payload]); },
  });

  await sendImage('dc:123:456', {
    base64: 'Zm9v',
    caption: 'print de erro',
    fileName: 'erro.png',
    mimetype: 'image/png',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '456');
  assert.equal(calls[0][1].base64, 'Zm9v');
  assert.equal(calls[0][1].caption, 'print de erro');
  assert.equal(calls[0][1].fileName, 'erro.png');
  assert.equal(calls[0][1].mimetype, 'image/png');

  __resetMessengerAdaptersForTest();
});

test('messenger routes sendAudio and sendFile to Discord adapters', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    sendDiscordAudio: async (channelId, payload) => { calls.push(['audio', channelId, payload.fileName]); },
    sendDiscordFile: async (channelId, payload) => { calls.push(['file', channelId, payload.fileName]); },
  });

  await sendAudio('dc:123:456', {
    base64: 'Zm9v',
    caption: 'audio teste',
    fileName: 'sample.ogg',
    mimetype: 'audio/ogg',
  });

  await sendFile('dc:123:456', {
    base64: 'Zm9v',
    caption: 'arquivo teste',
    fileName: 'report.pdf',
    mimetype: 'application/pdf',
  });

  assert.deepEqual(calls, [
    ['audio', '456', 'sample.ogg'],
    ['file', '456', 'report.pdf'],
  ]);

  __resetMessengerAdaptersForTest();
});

test('messenger sends fallback text when Discord media upload fails', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    sendDiscordImage: async () => {
      throw new Error('too large');
    },
    sendDiscordMessage: async (channelId, text) => {
      calls.push([channelId, text]);
    },
  });

  await sendImage('dc:123:456', { base64: 'Zm9v', caption: 'print de erro' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '456');
  assert.match(calls[0][1], /Falha ao enviar imagem/i);
  assert.match(calls[0][1], /too large/i);
  assert.match(calls[0][1], /print de erro/i);

  __resetMessengerAdaptersForTest();
});

test('messenger sendAudio/sendFile fallback to text for WhatsApp actors', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    sendWhatsAppMessage: async (to, text) => {
      calls.push([to, text]);
    },
  });

  await sendAudio('5511999999999', { base64: 'Zm9v' });
  await sendFile('5511999999999', { base64: 'Zm9v', fileName: 'report.pdf' });

  assert.equal(calls.length, 2);
  assert.match(calls[0][1], /WhatsApp/i);
  assert.match(calls[1][1], /WhatsApp/i);

  __resetMessengerAdaptersForTest();
});

test('messenger upsertMessage edits Discord message when supported', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    upsertDiscordMessage: async (channelId, text, { messageId }) => {
      calls.push([channelId, text, messageId]);
      return { primaryMessageId: 'msg-1', messageIds: ['msg-1'], edited: true };
    },
  });

  const out = await upsertMessage('dc:123:456', 'status atualizado', { messageId: 'msg-0' });

  assert.deepEqual(calls, [['456', 'status atualizado', 'msg-0']]);
  assert.equal(out.primaryMessageId, 'msg-1');

  __resetMessengerAdaptersForTest();
});

test('parseDiscordActorId parses actor id format', () => {
  assert.deepEqual(parseDiscordActorId('dc:guild:channel'), { guildId: 'guild', channelId: 'channel' });
  assert.equal(parseDiscordActorId('5511'), null);
});
