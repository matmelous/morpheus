export function truncate(text, maxLen) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n\n... (truncado)`;
}

export function parseCsvList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return defaultValue;
}

