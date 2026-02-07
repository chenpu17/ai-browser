#!/usr/bin/env node
// 20 个真实浏览场景测试脚本
// 用法: node tests/run-scenarios.mjs

import http from 'node:http';

const BASE = 'http://localhost:3000';
const TIMEOUT = 300_000; // 300s per task

function log(msg) {
  process.stdout.write(msg + '\n');
}

// 20 个场景任务
const scenarios = [
  { id: 1,  name: 'Hacker News 头条', task: '打开 Hacker News (https://news.ycombinator.com)，获取首页前5条新闻的标题和链接' },
  { id: 2,  name: '百度搜索天气', task: '打开百度 (https://www.baidu.com)，搜索"北京天气"，获取搜索结果中的天气信息' },
  { id: 3,  name: 'GitHub 热门项目', task: '打开 GitHub Trending (https://github.com/trending)，获取今日前5个热门开源项目的名称和描述' },
  { id: 4,  name: 'Wikipedia 查询', task: '打开维基百科 (https://en.wikipedia.org)，搜索 "Artificial Intelligence"，获取文章的第一段摘要' },
  { id: 5,  name: 'Example.com 基础', task: '打开 https://example.com，获取页面的标题和正文内容' },
  { id: 6,  name: 'Stack Overflow 热门', task: '打开 Stack Overflow (https://stackoverflow.com/questions?tab=hot)，获取当前热门问题的前5个标题' },
  { id: 7,  name: 'NPM 包搜索', task: '打开 NPM (https://www.npmjs.com)，搜索 "fastify"，获取搜索结果中前3个包的名称和描述' },
  { id: 8,  name: 'GitHub Puppeteer', task: '打开 GitHub 上的 puppeteer 仓库 (https://github.com/puppeteer/puppeteer)，获取仓库的 star 数和描述' },
  { id: 9,  name: 'MDN 文档查阅', task: '打开 MDN (https://developer.mozilla.org)，搜索 "Promise"，获取 Promise 文档页面的简介部分' },
  { id: 10, name: 'Rust 官网信息', task: '打开 Rust 官网 (https://www.rust-lang.org)，获取首页展示的 Rust 语言核心特性介绍' },
  { id: 11, name: '豆瓣电影 Top250', task: '打开豆瓣电影 Top250 (https://movie.douban.com/top250)，获取前5部电影的名称和评分' },
  { id: 12, name: 'BBC 新闻头条', task: '打开 BBC News (https://www.bbc.com/news)，获取首页前5条新闻标题' },
  { id: 13, name: 'PyPI 包搜索', task: '打开 PyPI (https://pypi.org)，搜索 "requests"，获取搜索结果中前3个包的名称和描述' },
  { id: 14, name: 'W3Schools 教程', task: '打开 W3Schools (https://www.w3schools.com/html/)，获取 HTML 教程首页的章节目录列表' },
  { id: 15, name: 'Bing 搜索', task: '打开 Bing (https://www.bing.com)，搜索 "2025 AI news"，获取前5条搜索结果的标题' },
  { id: 16, name: 'httpbin 测试', task: '打开 https://httpbin.org，获取页面上列出的所有 API 端点分类' },
  { id: 17, name: 'JSON Placeholder', task: '打开 https://jsonplaceholder.typicode.com，获取页面上展示的可用资源列表和示例' },
  { id: 18, name: 'Books to Scrape', task: '打开 https://books.toscrape.com，获取首页前5本书的书名和价格' },
  { id: 19, name: 'Quotes to Scrape', task: '打开 https://quotes.toscrape.com，获取首页前5条名言的内容和作者' },
  { id: 20, name: 'HN 搜索', task: '打开 https://hn.algolia.com，搜索 "TypeScript"，获取前3条搜索结果的标题' },
];

// 启动 agent 并通过 SSE 收集结果
async function runScenario(scenario) {
  const startTime = Date.now();

  // 启动 agent
  const res = await fetch(`${BASE}/v1/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: scenario.task + '。获取到信息后立即用done工具报告结果，不要做额外操作。', maxIterations: 15 }),
  });
  const { agentId, error } = await res.json();
  if (!agentId) {
    return { ...scenario, success: false, error: error?.message || 'Failed to start', duration: 0, steps: 0, result: '' };
  }

  // SSE 监听 (用 http 模块，确保可以 destroy)
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

// 主流程：逐个执行
async function main() {
  log('='.repeat(80));
  log('AI Browser Agent - 20 场景实测');
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
  fs.writeFileSync('tests/scenario-results.json', JSON.stringify(results, null, 2));
  log('\n详细结果已保存到 tests/scenario-results.json');
}

main().catch(console.error);
