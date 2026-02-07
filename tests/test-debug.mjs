import http from 'node:http';

const BASE = 'http://localhost:3000';

function log(msg) { process.stdout.write(msg + '\n'); }

async function runScenario(task) {
  const startTime = Date.now();

  const res = await fetch(BASE + '/v1/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, maxIterations: 30 }),
  });
  const { agentId } = await res.json();
  log('agentId=' + agentId);

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      log('  TIMEOUT triggered');
      finish({ success: false, error: 'Timeout', steps: 0 });
    }, 90000);

    const url = new URL('/v1/agent/' + agentId + '/events', BASE);
    log('  SSE connecting to ' + url.href);

    const req = http.get(url, (sseRes) => {
      log('  SSE status=' + sseRes.statusCode);
      let buf = '';
      let steps = 0;

      sseRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.indexOf('data: ') !== 0) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            log('  [' + ev.type + '] ' + (ev.name || ''));
            if (ev.type === 'tool_call') steps++;
            if (ev.type === 'done') {
              req.destroy();
              finish({
                success: ev.success,
                error: ev.error || '',
                steps: ev.iterations || steps,
                result: ev.result || '',
                duration: Date.now() - startTime,
              });
            }
          } catch {}
        }
      });

      sseRes.on('end', () => {
        log('  SSE stream ended');
        finish({ success: false, error: 'SSE ended', steps: 0, duration: Date.now() - startTime });
      });
    });

    req.on('error', (e) => {
      log('  req error: ' + e.message);
      finish({ success: false, error: e.message, steps: 0, duration: Date.now() - startTime });
    });
  });
}

log('Testing HN scenario...');
const result = await runScenario('打开 Hacker News (https://news.ycombinator.com)，获取首页前5条新闻的标题和链接');
log('Result: ' + JSON.stringify(result).slice(0, 300));
process.exit(0);
