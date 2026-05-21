export type SseEvent = { event?: string; data: string };

export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return events;
}

export async function readSse(response: Response): Promise<SseEvent[]> {
  return parseSseEvents(await response.text());
}

export function extractCandidateText(value: unknown): string {
  const texts: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') texts.push(record.text);
    for (const key of ['response', 'candidates', 'content', 'parts']) visit(record[key]);
  };
  visit(value);
  return texts.join('');
}

export function extractTextFromSse(events: SseEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.data === '[DONE]') continue;
    try {
      const text = extractCandidateText(JSON.parse(event.data));
      if (text) chunks.push(text);
    } catch {
      // Ignore non-JSON data events in the spike parser.
    }
  }
  return chunks.join('');
}
