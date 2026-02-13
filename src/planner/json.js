export function parseFirstJsonObject(text) {
  if (typeof text !== 'string') throw new Error('Planner output is not a string');
  let s = text.trim();
  if (!s) throw new Error('Planner output is empty');

  // Strip markdown code fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) s = fence[1].trim();

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('Planner output does not contain a JSON object');
  }

  const candidate = s.slice(first, last + 1);
  return JSON.parse(candidate);
}

