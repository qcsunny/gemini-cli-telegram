export interface AgyTranscriptThoughtUpdate {
  stepIndex: number;
  content: string;
}

export function parseAgyTranscriptThoughtUpdates(
  raw: string,
  processedSteps: Set<number>,
  startedAt: number,
): AgyTranscriptThoughtUpdate[] {
  const updates: AgyTranscriptThoughtUpdate[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const stepIndex = Number(event['step_index']);
    if (!Number.isFinite(stepIndex) || processedSteps.has(stepIndex)) continue;
    if (event['status'] !== 'DONE') continue;

    const createdAt = typeof event['created_at'] === 'string'
      ? Date.parse(event['created_at'])
      : NaN;
    if (Number.isFinite(createdAt) && createdAt < startedAt - 2_000) {
      processedSteps.add(stepIndex);
      continue;
    }

    processedSteps.add(stepIndex);
    if (event['type'] === 'PLANNER_RESPONSE' && typeof event['thinking'] === 'string' && event['thinking']) {
      updates.push({ stepIndex, content: event['thinking'] });
    }
  }
  return updates;
}
