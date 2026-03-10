function normalizeText(value) {
  return String(value || '').trim();
}

export function buildMemorySections({
  sharedMemory = '',
  projectMemory = '',
  projectId = '',
} = {}) {
  const sections = [];
  const shared = normalizeText(sharedMemory);
  const project = normalizeText(projectMemory);
  const pid = normalizeText(projectId);

  if (shared) {
    sections.push(`[MEMORIA COMPARTILHADA]\n${shared}`);
  }
  if (project) {
    sections.push(`[MEMORIA DO PROJETO${pid ? ` ${pid}` : ''}]\n${project}`);
  }

  return sections.join('\n\n');
}

export function buildPromptWithMemories({
  prompt = '',
  sharedMemory = '',
  projectMemory = '',
  projectId = '',
} = {}) {
  const basePrompt = normalizeText(prompt);
  const memoryBlock = buildMemorySections({
    sharedMemory,
    projectMemory,
    projectId,
  });

  if (!memoryBlock) return basePrompt;
  if (!basePrompt) return memoryBlock;
  return `${memoryBlock}\n\n[PROMPT]\n${basePrompt}`;
}
