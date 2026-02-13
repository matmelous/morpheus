import crypto from 'crypto';

export function makeId(prefix) {
  // 12 hex chars (48 bits) is plenty for local task/run ids.
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

