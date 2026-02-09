#!/usr/bin/env node
// 第三批场景测试：覆盖新增 MCP 工具 + 经典导航回归
// 用法: node tests/run-scenarios-v3.mjs
// 可选: node tests/run-scenarios-v3.mjs --ids=1,2,5  只跑指定场景

import http from 'node:http';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TIMEOUT = 180_000;

function log(msg) {
  process.stdout.write(msg + '\n');
}

const scenarios = [
  // ===== 回归：经典导航+提取 =====
  { id: 1, name: 'Example.com 基础', task: '打开 https://example.com，获取页面标题和正文内容' },
  { id: 2, name: 'Hacker News 头条', task: '打开 Hacker News (https://news.ycombinator.com)，获取首页前5条新闻的标题' },
  { id: 3, name: 'GitHub 仓库信息', task: '打开 GitHub 上的 puppeteer 仓库 (https://github.com/puppeteer/puppeteer)，获取仓库的 star 数和描述' },

  // ===== 新功能：网络日志 =====
  { id: 4, name: '网络请求分析', task: '打开 https://jsonplaceholder.typicode.com，然后使用 get_network_logs 工具获取页面加载过程中的网络请求日志，报告有多少个请求、是否有失败的请求' },
  { id: 5, name: 'XHR 请求捕获', task: '打开 https://jsonplaceholder.typicode.com，然后用 execute_javascript 执行 fetch("/posts/1")，等待2秒后用 get_network_logs 工具（filter 设为 xhr）获取 XHR 请求，报告请求的 URL 和状态' },

  // ===== 新功能：控制台日志 =====
  { id: 6, name: '控制台错误检测', task: '打开 https://example.com，然后用 execute_javascript 执行 console.error("TEST_ERROR_123"); console.warn("TEST_WARN_456")，接着用 get_console_logs 工具获取控制台日志，报告捕获到的 error 和 warn 信息' },

  // ===== 新功能：弹窗处理 =====
  { id: 7, name: 'Alert 弹窗处理', task: '打开 https://example.com，然后用 execute_javascript 触发 alert("Hello from test")。注意弹窗会自动出现，用 get_dialog_info 查看弹窗历史，报告弹窗的类型和消息内容' },
  { id: 8, name: 'Confirm 弹窗交互', task: '打开 https://example.com，然后用 execute_javascript 执行代码触发 confirm 弹窗：window._testResult = "pending"; setTimeout(() => { window._testResult = confirm("Do you agree?") }, 100)。等待1秒后用 handle_dialog 工具 accept 这个弹窗，然后用 execute_javascript 获取 window._testResult 的值，报告弹窗处理结果' },

  // ===== 新功能：页面稳定性 =====
  { id: 9, name: '页面稳定性检测', task: '打开 https://news.ycombinator.com，然后使用 wait_for_stable 工具等待页面稳定，报告页面是否稳定以及稳定性状态详情' },
  { id: 10, name: '动态页面等待', task: '打开 https://example.com，用 execute_javascript 执行 setTimeout(() => document.body.appendChild(Object.assign(document.createElement("div"), {id:"dynamic-content", textContent:"Dynamic loaded!"})), 2000)，然后用 wait_for_stable 等待页面稳定（timeout 设为 5000），稳定后用 execute_javascript 获取 document.getElementById("dynamic-content")?.textContent，报告动态内容是否成功加载' },

  // ===== 新功能：增强的 get_page_info =====
  { id: 11, name: '页面信息含稳定性', task: '打开 https://example.com，使用 get_page_info 获取页面信息，报告页面的交互元素数量以及返回结果中是否包含 stability 字段及其内容' },

  // ===== 新功能：文件上传（无真实 file input 可测，验证错误处理） =====
  { id: 12, name: '上传文件错误处理', task: '使用 upload_file 工具尝试上传一个不存在的文件 /tmp/nonexistent_test_file_12345.txt 到元素 input_file_1，报告返回的错误信息' },

  // ===== 新功能：下载列表 =====
  { id: 13, name: '下载列表查询', task: '打开 https://example.com，然后使用 get_downloads 工具查询当前的下载文件列表，报告列表内容（预期为空）' },

  // ===== 补充：弹窗处理分支覆盖 =====
  { id: 14, name: 'Confirm dismiss', task: '打开 https://example.com，用 execute_javascript 执行 setTimeout(() => { window._dismissResult = confirm("Cancel this?") }, 5000)。注意：弹窗会在5秒后出现，请立即用 wait 工具等待6秒让弹窗出现，然后用 handle_dialog 工具 dismiss 这个弹窗，再用 execute_javascript 获取 window._dismissResult 的值，报告结果（预期为 false）' },
  { id: 15, name: 'Prompt 弹窗输入', task: '打开 https://example.com，用 execute_javascript 执行 setTimeout(() => { window._promptValue = prompt("Enter your name:", "default") }, 5000)。注意：弹窗会在5秒后出现，请立即用 wait 工具等待6秒让弹窗出现，然后用 handle_dialog 工具 accept 这个弹窗并传入 text 参数 "TestUser"，再用 execute_javascript 获取 window._promptValue 的值，报告弹窗返回值（预期为 "TestUser"）' },

  // ===== 补充：网络日志过滤分支 =====
  { id: 16, name: '失败请求过滤', task: '打开 https://example.com，用 execute_javascript 执行 fetch("/nonexistent-path-404-test")，等待2秒后用 get_network_logs 工具（filter 设为 failed）获取失败的网络请求，报告是否捕获到失败请求及其 URL 和状态码' },

  // ===== 补充：控制台日志全级别 =====
  { id: 17, name: '控制台全级别日志', task: '打开 https://example.com，用 execute_javascript 执行 console.error("E1"); console.warn("W1"); console.log("L1"); console.info("I1")，然后用 get_console_logs 工具（level 设为 all）获取所有级别的控制台日志，报告捕获到几条日志以及各自的级别和内容' },

  // ===== 补充：交互→验证型组合 =====
  { id: 18, name: '点击+网络验证', task: '打开 https://jsonplaceholder.typicode.com，用 get_page_info 找到页面上的链接，点击 Guide 链接（或第一个可点击链接），等待2秒后用 get_network_logs 获取网络日志，报告点击后产生了哪些新的网络请求' },
  { id: 19, name: '弹窗+后续交互', task: '打开 https://example.com，用 execute_javascript 执行 alert("Step 1 done")，等待弹窗自动处理后，用 get_dialog_info 确认弹窗已处理，然后继续用 get_page_content 获取页面内容，报告弹窗处理状态和页面内容（验证弹窗不阻塞后续操作）' },
  { id: 20, name: '错误注入+诊断', task: '打开 https://example.com，用 execute_javascript 执行以下代码制造错误：console.error("INJECTED_ERROR"); fetch("/api/broken-endpoint")。等待2秒后，分别用 get_console_logs 和 get_network_logs（filter 设为 failed）进行诊断，汇总报告控制台错误和失败的网络请求' },

  // ===== 综合场景：多工具协作 =====
  { id: 21, name: '综合诊断', task: '打开 https://jsonplaceholder.typicode.com，执行以下诊断步骤：1) 用 wait_for_stable 确认页面稳定 2) 用 get_page_info 获取页面元素概况 3) 用 get_network_logs 获取网络请求概况 4) 用 get_console_logs 检查是否有控制台错误。汇总报告这4项诊断结果' },
  { id: 22, name: '搜索+稳定性', task: '打开 NPM (https://www.npmjs.com)，搜索 "express"，搜索后用 wait_for_stable 等待结果页面稳定，然后获取前3个搜索结果的包名和描述' },
];

async function runScenario(scenario) {
  const startTime = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/v1/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: scenario.task + '。获取到信息后立即用done工具报告结果，不要做额外操作。',
        maxIterations: 15,
      }),
    });
  } catch (err) {
    return { ...scenario, success: false, error: `Fetch error: ${err.message}`, duration: 0, steps: 0, result: '' };
  }
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
      const toolCalls = [];
      sseRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'tool_call') {
              steps++;
              toolCalls.push(ev.name);
            }
            if (ev.type === 'done') {
              req.destroy();
              done({
                ...scenario,
                success: ev.success,
                error: ev.error || '',
                duration: Date.now() - startTime,
                steps: ev.iterations || steps,
                result: ev.result || '',
                toolCalls,
              });
            }
          } catch {}
        }
      });
      sseRes.on('end', () => {
        done({ ...scenario, success: false, error: 'SSE stream ended', duration: Date.now() - startTime, steps: 0, result: '', toolCalls });
      });
    });
    req.on('error', (err) => {
      done({ ...scenario, success: false, error: err.message, duration: Date.now() - startTime, steps: 0, result: '', toolCalls: [] });
    });
  });
}

async function main() {
  // Parse --ids flag
  const idsArg = process.argv.find(a => a.startsWith('--ids='));
  let selectedIds = null;
  if (idsArg) {
    selectedIds = new Set(idsArg.slice(6).split(',').map(Number));
  }
  const toRun = selectedIds ? scenarios.filter(s => selectedIds.has(s.id)) : scenarios;

  log('='.repeat(80));
  log(`AI Browser Agent - v3 场景实测 (${toRun.length} 个场景)`);
  log('覆盖: 经典导航回归 + 网络日志 + 控制台日志 + 弹窗处理 + 页面稳定性 + 文件处理 + 交互验证组合');
  log('='.repeat(80));
  log('');

  const results = [];

  for (const scenario of toRun) {
    log(`[${scenario.id}/${scenarios.length}] ${scenario.name}`);
    log(`  任务: ${scenario.task.slice(0, 100)}${scenario.task.length > 100 ? '...' : ''}`);

    const result = await runScenario(scenario);
    results.push(result);

    const status = result.success ? '\u2705 \u6210\u529f' : '\u274c \u5931\u8d25';
    const dur = (result.duration / 1000).toFixed(1);
    log(`  ${status} | ${result.steps} \u6b65 | ${dur}s`);
    if (result.toolCalls?.length) {
      log(`  \u5de5\u5177: ${[...new Set(result.toolCalls)].join(', ')}`);
    }
    if (result.success && result.result) {
      const preview = result.result.length > 200 ? result.result.slice(0, 200) + '...' : result.result;
      log(`  \u7ed3\u679c: ${preview}`);
    }
    if (!result.success && result.error) {
      log(`  \u9519\u8bef: ${result.error}`);
    }
    log('');
  }

  log('='.repeat(80));
  log('\u6c47\u603b');
  log('='.repeat(80));
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalTime = results.reduce((s, r) => s + r.duration, 0);
  log(`\u901a\u8fc7: ${passed}/${toRun.length} | \u5931\u8d25: ${failed}/${toRun.length} | \u603b\u8017\u65f6: ${(totalTime / 1000).toFixed(1)}s`);
  log('');

  // Check new tool coverage
  const allToolCalls = results.flatMap(r => r.toolCalls || []);
  const newTools = ['handle_dialog', 'get_dialog_info', 'wait_for_stable', 'get_network_logs', 'get_console_logs', 'upload_file', 'get_downloads'];
  const coveredNew = newTools.filter(t => allToolCalls.includes(t));
  const uncoveredNew = newTools.filter(t => !allToolCalls.includes(t));
  log(`\u65b0\u5de5\u5177\u8986\u76d6: ${coveredNew.length}/${newTools.length}`);
  if (coveredNew.length) log(`  \u2705 \u5df2\u8986\u76d6: ${coveredNew.join(', ')}`);
  if (uncoveredNew.length) log(`  \u274c \u672a\u8986\u76d6: ${uncoveredNew.join(', ')}`);
  log('');

  log('ID | \u573a\u666f             | \u72b6\u6001 | \u6b65\u6570 | \u8017\u65f6  | \u65b0\u5de5\u5177');
  log('---|------------------|------|------|-------|--------');
  for (const r of results) {
    const s = r.success ? '\u2705' : '\u274c';
    const name = r.name.padEnd(16);
    const dur = (r.duration / 1000).toFixed(1).padStart(5) + 's';
    const steps = String(r.steps).padStart(4);
    const usedNew = (r.toolCalls || []).filter(t => newTools.includes(t));
    const newStr = usedNew.length ? [...new Set(usedNew)].join(',') : '-';
    log(`${String(r.id).padStart(2)} | ${name} | ${s}   | ${steps} | ${dur} | ${newStr}`);
  }

  const fs = await import('fs');
  fs.writeFileSync('tests/scenario-results-v3.json', JSON.stringify(results, null, 2));
  log('\n\u8be6\u7ec6\u7ed3\u679c\u5df2\u4fdd\u5b58\u5230 tests/scenario-results-v3.json');
}

main().catch(console.error);
