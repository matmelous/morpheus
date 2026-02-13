export function detectPurchaseIntent(text) {
  const t = String(text || '').toLowerCase();
  const hits = [
    'checkout', 'payment', 'pagar', 'pagamento',
    'comprar', 'finalizar compra', 'finalizar', 'confirm purchase',
    'place order', 'buy now', 'finalizar pedido',
  ];
  return hits.some((h) => t.includes(h));
}

export function parseFirstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  for (let i = start; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') depth--;
      if (depth === 0) {
        const candidate = s.slice(i, j + 1);
        try { return JSON.parse(candidate); } catch { break; }
      }
    }
  }
  return null;
}

