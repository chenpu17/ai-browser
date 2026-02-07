#!/usr/bin/env node
// 重跑之前失败的场景: #2, #3, #4
import http from 'node:http';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TIMEOUT = 300_000;

function log(msg) {
  process.stdout.write(msg + '\n');
}

const scenarios = [
  { id: 2,  name: '百度搜索天气', task: '打开百度 (https://www.baidu.com)，搜索"北京天气"，获取搜索结果中的天气信息' },
  { id: 3,  name: 'GitHub 热门项目', task: '打开 GitHub Trending (https://github.com/trending)，获取今日前5个热门开源项目的名称和描述' },
  { id: 4,  name: 'Wikipedia 查询', task: '打开维基百科 (https://en.wikipedia.org)，搜索 "Artificial Intelligence"，获取文章的第一段摘要' },
];

async function runScenario(scenario) {
  const startTime = Date.now();
  const res = await fetch(`${BASE}/v1/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: scenario.task + '。获取到信息后立即用done工具报告结果，不要做额外操作。', maxIterations: 15 }),
  });
  const { agentId, error } = await res.json();
  if (!agentId) {
    return { ...scenario, success: false, error: error?.message || 'Failed to start', duration: 0, steps: 0, result: '' };
  }

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ ...scenario, success: false, error: 'Timeout', duration: TIMEOUT, steps: 0, result: '' });
    }, TIMEOUT);

    const url = new URL(`/v1/agent/${agentId}/events`, BASE);
    const req = http.get(url, (sseRes) => {
      let buf = '';
      let steps = 0;
      sseRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'tool_call') steps++;
            if (ev.type === 'done') {
              req.destroy();
              done({
                ...scenario,
                success: ev.success,
                error: ev.error || '',
                duration: Date.now() - startTime,
                steps: ev.iterations || steps,
                result: ev.result || '',
              });
            }
          } catch {}
        }
      });
      sseRes.on('end', () => {
        done({ ...scenario, success: false, error: 'SSE stream ended', duration: Date.now() - startTime, steps: 0, result: '' });
      });
    });
    req.on('error', (err) => {
      done({ ...scenario, success: false, error: err.message, duration: Date.now() - startTime, steps: 0, result: '' });
    });
  });
}

async function main() {
  log('='.repeat(60));
  log('重跑失败场景: #2, #3, #4');
  log('='.repeat(60));
  log('');

  for (const scenario of scenarios) {
    log(`[${scenario.id}] ${scenario.name}`);
    log(`  任务: ${scenario.task}`);
    const result = await runScenario(scenario);
    const status = result.success ? '✅ 成功' : '❌ 失败';
    const dur = (result.duration / 1000).toFixed(1);
    log(`  ${status} | ${result.steps} 步 | ${dur}s`);
    if (result.success && result.result) {
      const preview = result.result.length > 300 ? result.result.slice(0, 300) + '...' : result.result;
      log(`  结果: ${preview}`);
    }
    if (!result.success && result.error) {
      log(`  错误: ${result.error}`);
    }
    log('');
  }
}

main().catch(console.error);
