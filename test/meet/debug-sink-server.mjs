// Receives the extension's opt-in debug copies (see src/offscreen/debug-sink.js), which
// only a debug build has (`npm run build:debug`, then reload the extension):
//
//   node test/meet/debug-sink-server.mjs [port]      (default 8787)
//
// then, in the Meet tab's console: localStorage['meet-tercuman-debug'] = '<port>'
// Each translation session lands in test/meet/out/debug/<session>/: in.pcm and out.pcm
// (16 kHz mono 16-bit, exactly what speech recognition got), events.jsonl (partials,
// commits, captions, chunk timing) and recording.mp4 (the call recording).

import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 8787);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'debug');
const sessions = new Map();

function session(name) {
  if (!sessions.has(name)) {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    sessions.set(name, { dir, streams: {} });
    console.log(`session ${name} -> ${dir}`);
  }
  return sessions.get(name);
}

// Parts can arrive out of order; each stream is written in sequence.
function writeInOrder(s, stream, seq, body) {
  const st = (s.streams[stream] ||= { next: 0, waiting: new Map() });
  st.waiting.set(seq, body);
  const file = path.join(s.dir, stream === 'recording' ? 'recording.mp4' : `${stream.slice(4)}.pcm`);
  while (st.waiting.has(st.next)) {
    appendFileSync(file, st.waiting.get(st.next));
    st.waiting.delete(st.next);
    st.next += 1;
  }
}

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const parts = req.url.split('/').filter(Boolean);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const s = parts[0] && session(parts[0].replace(/[^\w-]/g, ''));
      if (s && parts[1] === 'event') appendFileSync(path.join(s.dir, 'events.jsonl'), `${body.toString()}\n`);
      else if (s && /^(pcm-in|pcm-out|recording)$/.test(parts[1]) && /^\d+$/.test(parts[2] || '')) writeInOrder(s, parts[1], Number(parts[2]), body);
      else return res.writeHead(404).end();
      res.writeHead(204).end();
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`debug sink on http://127.0.0.1:${port}`));
