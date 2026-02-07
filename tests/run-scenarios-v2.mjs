#!/usr/bin/env node
// 第二批 20 个真实浏览场景测试脚本
// 用法: node tests/run-scenarios-v2.mjs

import http from 'node:http';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TIMEOUT = 300_000;

function log(msg) {
  process.stdout.write(msg + '\n');
}

// 第二批 20 个场景：覆盖更多交互模式和网站类型
const scenarios = [
  { id: 1,  name: 'DuckDuckGo 搜索', task: '打开 DuckDuckGo (https://duckduckgo.com)，搜索 "machine learning"，获取前5条搜索结果的标题' },
  { id: 2,  name: 'GitHub 仓库文件', task: '打开 GitHub 上的 fastify 仓库 (https://github.com/fastify/fastify)，获取仓库的 star 数、最新版本号和简介' },
  { id: 3,  name: 'Reddit 热帖', task: '打开 Reddit 的 programming 板块 (https://www.reddit.com/r/programming/)，获取前5条热门帖子的标题' },
  { id: 4,  name: 'Crates.io 搜索', task: '打开 Rust 包管理器 (https://crates.io)，搜索 "serde"，获取前3个搜索结果的包名、版本和描述' },
  { id: 5,  name: 'Product Hunt 今日', task: '打开 Product Hunt (https://www.producthunt.com)，获取今日前3个产品的名称和简介' },
  { id: 6,  name: 'Can I Use 查询', task: '打开 Can I Use (https://caniuse.com)，搜索 "flexbox"，获取 flexbox 的浏览器兼容性概要' },
  { id: 7,  name: 'Docker Hub 搜索', task: '打开 Docker Hub (https://hub.docker.com)，搜索 "nginx"，获取前3个镜像的名称和拉取次数' },
  { id: 8,  name: 'arXiv 论文', task: '打开 arXiv (https://arxiv.org)，搜索 "transformer attention"，获取前3篇论文的标题和作者' },
  { id: 9,  name: 'Y Combinator 公司', task: '打开 Y Combinator 公司列表 (https://www.ycombinator.com/companies)，获取页面上前5家公司的名称和简介' },
  { id: 10, name: 'TypeScript 文档', task: '打开 TypeScript 官网 (https://www.typescriptlang.org)，获取首页展示的 TypeScript 核心特性介绍' },
  { id: 11, name: 'Go 官网', task: '打开 Go 语言官网 (https://go.dev)，获取首页展示的 Go 语言核心特性和使用场景' },
  { id: 12, name: 'Hacker News 最新', task: '打开 Hacker News 最新页面 (https://news.ycombinator.com/newest)，获取前5条最新提交的标题' },
  { id: 13, name: 'GitHub Issues', task: '打开 Node.js 的 GitHub Issues (https://github.com/nodejs/node/issues)，获取前5个 open issue 的标题' },
  { id: 14, name: 'Maven Central', task: '打开 Maven Central (https://search.maven.org)，搜索 "spring-boot"，获取前3个搜索结果的 groupId 和 artifactId' },
  { id: 15, name: 'CSS Tricks 文章', task: '打开 CSS-Tricks (https://css-tricks.com)，获取首页前3篇文章的标题' },
  { id: 16, name: 'Dev.to 热门', task: '打开 Dev.to (https://dev.to)，获取首页前5篇热门文章的标题和作者' },
  { id: 17, name: 'Lobsters 技术新闻', task: '打开 Lobsters (https://lobste.rs)，获取首页前5条新闻的标题和来源域名' },
  { id: 18, name: 'Homebrew 公式', task: '打开 Homebrew Formulae (https://formulae.brew.sh)，获取首页展示的热门公式列表中前5个包名' },
  { id: 19, name: 'Python 官网', task: '打开 Python 官网 (https://www.python.org)，获取首页展示的最新 Python 版本号和主要特性' },
  { id: 20, name: 'Cloudflare Radar', task: '打开 Cloudflare Radar (https://radar.cloudflare.com)，获取页面上展示的全球互联网流量概要信息' },
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
  log('='.repeat(80));
  log('AI Browser Agent - 第二批 20 场景实测');
  log('='.repeat(80));
  log('');

  const results = [];

  for (const scenario of scenarios) {
    log(`[${scenario.id}/20] ${scenario.name}`);
    log(`  任务: ${scenario.task}`);

    const result = await runScenario(scenario);
    results.push(result);

    const status = result.success ? '✅ 成功' : '❌ 失败';
    const dur = (result.duration / 1000).toFixed(1);
    log(`  ${status} | ${result.steps} 步 | ${dur}s`);
    if (result.success && result.result) {
      const preview = result.result.length > 200 ? result.result.slice(0, 200) + '...' : result.result;
      log(`  结果: ${preview}`);
    }
    if (!result.success && result.error) {
      log(`  错误: ${result.error}`);
    }
    log('');
  }

  log('='.repeat(80));
  log('汇总');
  log('='.repeat(80));
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalTime = results.reduce((s, r) => s + r.duration, 0);
  log(`通过: ${passed}/20 | 失败: ${failed}/20 | 总耗时: ${(totalTime / 1000).toFixed(1)}s`);
  log('');

  log('ID | 场景             | 状态 | 步数 | 耗时');
  log('---|------------------|------|------|------');
  for (const r of results) {
    const s = r.success ? '✅' : '❌';
    const name = r.name.padEnd(16);
    const dur = (r.duration / 1000).toFixed(1).padStart(5) + 's';
    const steps = String(r.steps).padStart(4);
    log(`${String(r.id).padStart(2)} | ${name} | ${s}   | ${steps} | ${dur}`);
  }

  const fs = await import('fs');
  fs.writeFileSync('tests/scenario-results-v2.json', JSON.stringify(results, null, 2));
  log('\n详细结果已保存到 tests/scenario-results-v2.json');
}

main().catch(console.error);
