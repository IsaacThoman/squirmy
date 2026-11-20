// Generates the engine bench's test tones with ffmpeg and serves them, with Range support
// (AVPlayer requires it), on port 4800 or $PORT. The tones are very quiet; nothing is
// written inside the repository.
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = path.join(tmpdir(), 'squirmy-engine-tones');
const port = Number(process.env.PORT ?? 4800);
const tones = { 'tone-a.m4a': [440, 20], 'tone-b.m4a': [660, 8], 'tone-c.m4a': [550, 8] };

mkdirSync(dir, { recursive: true });
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
for (const [file, [frequency, seconds]] of Object.entries(tones)) {
  ffmpeg('-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`, '-af', 'volume=-50dB', '-c:a', 'aac', '-b:a', '96k', path.join(dir, file));
}
ffmpeg('-f', 'lavfi', '-i', 'color=c=0x5B439E:s=600x600', '-frames:v', '1', path.join(dir, 'art.png'));

const types = { '.m4a': 'audio/mp4', '.png': 'image/png' };

createServer((request, response) => {
  const file = path.join(dir, path.basename(decodeURIComponent(new URL(request.url, 'http://x').pathname)));
  let size;
  try {
    size = statSync(file).size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  const headers = { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  if (!range) {
    response.writeHead(200, { ...headers, 'content-length': size });
    if (request.method === 'HEAD') return response.end();
    return createReadStream(file).pipe(response);
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  response.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
  if (request.method === 'HEAD') return response.end();
  createReadStream(file, { start, end }).pipe(response);
}).listen(port, () => console.log(`Engine bench tones on http://localhost:${port} (from ${dir})`));
