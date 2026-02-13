export function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}m ${sec}s`;
}

export function formatDurationMs(ms) {
  if (ms == null) return '?';
  const v = Math.max(0, Math.floor(ms));
  if (v < 1000) return `${v}ms`;
  return formatElapsed(v / 1000);
}

