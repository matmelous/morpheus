import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPurchaseIntent, parseFirstJsonObject } from './desktop-agent-utils.js';

test('detectPurchaseIntent: portuguese keywords', () => {
  assert.equal(detectPurchaseIntent('vamos comprar agora'), true);
  assert.equal(detectPurchaseIntent('finalizar compra'), true);
  assert.equal(detectPurchaseIntent('apenas pesquisar preco'), false);
});

test('detectPurchaseIntent: english keywords', () => {
  assert.equal(detectPurchaseIntent('go to checkout and pay'), true);
  assert.equal(detectPurchaseIntent('place order'), true);
  assert.equal(detectPurchaseIntent('open the homepage'), false);
});

test('parseFirstJsonObject: extracts first json object from text', () => {
  const obj = parseFirstJsonObject('hello {"a":1,"b":{"c":2}} trailing');
  assert.deepEqual(obj, { a: 1, b: { c: 2 } });
});

