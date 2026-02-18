import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetMessengerAdaptersForTest,
  __setMessengerAdaptersForTest,
  parseDiscordActorId,
  sendImage,
  sendMessage,
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

test('messenger sendImage falls back to text on discord', async () => {
  const calls = [];
  __setMessengerAdaptersForTest({
    sendDiscordMessage: async (channelId, text) => { calls.push([channelId, text]); },
  });

  await sendImage('dc:123:456', { base64: 'Zm9v', caption: 'print de erro' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '456');
  assert.match(calls[0][1], /Discord/i);
  assert.match(calls[0][1], /print de erro/i);

  __resetMessengerAdaptersForTest();
});

test('parseDiscordActorId parses actor id format', () => {
  assert.deepEqual(parseDiscordActorId('dc:guild:channel'), { guildId: 'guild', channelId: 'channel' });
  assert.equal(parseDiscordActorId('5511'), null);
});
