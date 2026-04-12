export const USER_LOG_LEVELS = ['silent', 'normal', 'verbose'];

const LOG_LEVEL_ALIASES = new Map([
  ['silent', 'silent'],
  ['silencioso', 'silent'],
  ['quiet', 'silent'],
  ['low', 'silent'],
  ['normal', 'normal'],
  ['padrao', 'normal'],
  ['default', 'normal'],
  ['verbose', 'verbose'],
  ['detalhado', 'verbose'],
  ['debug', 'verbose'],
  ['high', 'verbose'],
]);

export function parseUserLogLevel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  return LOG_LEVEL_ALIASES.get(raw) || null;
}

export function normalizeUserLogLevel(value, fallback = 'silent') {
  const normalizedFallback = USER_LOG_LEVELS.includes(String(fallback || '').trim().toLowerCase())
    ? String(fallback || '').trim().toLowerCase()
    : 'silent';

  return parseUserLogLevel(value) || normalizedFallback;
}

export function isVerboseLogLevel(value) {
  return normalizeUserLogLevel(value) === 'verbose';
}

export function isSilentLogLevel(value) {
  return normalizeUserLogLevel(value) === 'silent';
}

export function listUserLogLevels() {
  return [...USER_LOG_LEVELS];
}
