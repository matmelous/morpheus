import test from 'node:test';
import assert from 'node:assert/strict';
import { extFromMime, buildCanonicalMediaMessage } from './media-utils.js';

test('extFromMime maps common image types', () => {
  assert.equal(extFromMime('image/png'), 'png');
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.equal(extFromMime('image/webp'), 'webp');
});

test('extFromMime maps common audio types', () => {
  assert.equal(extFromMime('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extFromMime('audio/mpeg'), 'mp3');
  assert.equal(extFromMime('audio/mp4'), 'm4a');
});

test('buildCanonicalMediaMessage includes key fields', () => {
  const msg = buildCanonicalMediaMessage({
    kind: 'image',
    caption: 'print do erro',
    visionText: 'Erro: X',
    filePath: '/tmp/a.png',
    mimetype: 'image/png',
    messageId: 'abc',
  });
  assert.match(msg, /\[MIDIA: IMAGE\]/);
  assert.match(msg, /print do erro/);
  assert.match(msg, /Erro: X/);
  assert.match(msg, /\/tmp\/a\.png/);
});

