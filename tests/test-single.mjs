import http from 'node:http';

const res = await fetch('http://localhost:3000/v1/agent/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ task: '打开 https://example.com，获取页面标题', maxIterations: 5 }),
});
const { agentId } = await res.json();
process.stdout.write('agentId=' + agentId + '\n');

const url = new URL('/v1/agent/' + agentId + '/events', 'http://localhost:3000');
const req = http.get(url, (sseRes) => {
  let buf = '';
  sseRes.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.indexOf('data: ') !== 0) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        const info = ev.name || (ev.content || '').slice(0, 40) || '';
        process.stdout.write('[' + ev.type + '] ' + info + '\n');
        if (ev.type === 'done') {
          process.stdout.write('success=' + ev.success + ' steps=' + ev.iterations + '\n');
          if (ev.result) process.stdout.write('result: ' + ev.result.slice(0, 300) + '\n');
          req.destroy();
          process.exit(0);
        }
      } catch {}
    }
  });
});

setTimeout(() => { process.stdout.write('TIMEOUT\n'); process.exit(1); }, 60000);
