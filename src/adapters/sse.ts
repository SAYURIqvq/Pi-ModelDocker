import { PiModelDockerError } from '../contracts.js';

/** Incremental SSE decoder: UTF-8 boundaries, CR/LF/CRLF and multi-line data. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], dataSize = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) throw new PiModelDockerError('invalid_response', 'SSE frame exceeded the size limit.');
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!done && buffer[index] === '\r' && index === buffer.length - 1)) break;
        const line = buffer.slice(0, index);
        const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(index + length);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = []; dataSize = 0;
        } else if (line.startsWith('data:')) {
          const part = line.slice(5).replace(/^ /, ''); data.push(part); dataSize += part.length;
          if (dataSize > 2_000_000) throw new PiModelDockerError('invalid_response', 'SSE frame exceeded the size limit.');
        }
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
        if (data.length) yield data.join('\n');
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
