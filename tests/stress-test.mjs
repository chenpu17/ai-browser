/**
 * AI Browser 综合网站测试 & 内存监控
 * 测试50+网站的语义分析、内容提取能力，并记录服务端内存开销
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = 'http://127.0.0.1:3000';

// 测试网站列表（分类）
const TEST_SITES = [
  // === 搜索引擎 ===
  { url: 'https://www.bing.com', category: '搜索引擎', name: 'Bing' },
  { url: 'https://www.google.com', category: '搜索引擎', name: 'Google' },
  { url: 'https://www.baidu.com', category: '搜索引擎', name: '百度' },
  { url: 'https://duckduckgo.com', category: '搜索引擎', name: 'DuckDuckGo' },
  { url: 'https://search.yahoo.com', category: '搜索引擎', name: 'Yahoo Search' },

  // === 视频平台 ===
  { url: 'https://www.bilibili.com', category: '视频平台', name: 'Bilibili' },
  { url: 'https://www.youtube.com', category: '视频平台', name: 'YouTube' },
  { url: 'https://www.iqiyi.com', category: '视频平台', name: '爱奇艺' },
  { url: 'https://v.qq.com', category: '视频平台', name: '腾讯视频' },
  { url: 'https://www.youku.com', category: '视频平台', name: '优酷' },

  // === 社交媒体 ===
  { url: 'https://weibo.com', category: '社交媒体', name: '微博' },
  { url: 'https://www.zhihu.com', category: '社交媒体', name: '知乎' },
  { url: 'https://www.douban.com', category: '社交媒体', name: '豆瓣' },
  { url: 'https://twitter.com', category: '社交媒体', name: 'Twitter/X' },
  { url: 'https://www.reddit.com', category: '社交媒体', name: 'Reddit' },

  // === 新闻资讯 ===
  { url: 'https://news.ycombinator.com', category: '新闻资讯', name: 'Hacker News' },
  { url: 'https://www.bbc.com', category: '新闻资讯', name: 'BBC' },
  { url: 'https://www.cnn.com', category: '新闻资讯', name: 'CNN' },
  { url: 'https://www.163.com', category: '新闻资讯', name: '网易' },
  { url: 'https://www.sina.com.cn', category: '新闻资讯', name: '新浪' },
  { url: 'https://www.ifeng.com', category: '新闻资讯', name: '凤凰网' },
  { url: 'https://www.theguardian.com', category: '新闻资讯', name: 'The Guardian' },
  { url: 'https://www.reuters.com', category: '新闻资讯', name: 'Reuters' },

  // === 电商平台 ===
  { url: 'https://www.taobao.com', category: '电商平台', name: '淘宝' },
  { url: 'https://www.jd.com', category: '电商平台', name: '京东' },
  { url: 'https://www.amazon.com', category: '电商平台', name: 'Amazon' },
  { url: 'https://www.ebay.com', category: '电商平台', name: 'eBay' },
  { url: 'https://www.pinduoduo.com', category: '电商平台', name: '拼多多' },

  // === 技术开发 ===
  { url: 'https://github.com', category: '技术开发', name: 'GitHub' },
  { url: 'https://stackoverflow.com', category: '技术开发', name: 'StackOverflow' },
  { url: 'https://developer.mozilla.org', category: '技术开发', name: 'MDN' },
  { url: 'https://www.npmjs.com', category: '技术开发', name: 'npm' },
  { url: 'https://gitlab.com', category: '技术开发', name: 'GitLab' },
  { url: 'https://juejin.cn', category: '技术开发', name: '掘金' },
  { url: 'https://www.csdn.net', category: '技术开发', name: 'CSDN' },
  { url: 'https://segmentfault.com', category: '技术开发', name: 'SegmentFault' },

  // === 工具类 ===
  { url: 'https://translate.google.com', category: '工具类', name: 'Google Translate' },
  { url: 'https://www.wikipedia.org', category: '工具类', name: 'Wikipedia' },
  { url: 'https://www.wolframalpha.com', category: '工具类', name: 'WolframAlpha' },
  { url: 'https://www.speedtest.net', category: '工具类', name: 'Speedtest' },

  // === 邮箱/办公 ===
  { url: 'https://mail.google.com', category: '邮箱/办公', name: 'Gmail' },
  { url: 'https://outlook.live.com', category: '邮箱/办公', name: 'Outlook' },
  { url: 'https://docs.google.com', category: '邮箱/办公', name: 'Google Docs' },
  { url: 'https://www.notion.so', category: '邮箱/办公', name: 'Notion' },

  // === 娱乐/生活 ===
  { url: 'https://www.spotify.com', category: '娱乐/生活', name: 'Spotify' },
  { url: 'https://www.twitch.tv', category: '娱乐/生活', name: 'Twitch' },
  { url: 'https://www.imdb.com', category: '娱乐/生活', name: 'IMDB' },
  { url: 'https://www.tripadvisor.com', category: '娱乐/生活', name: 'TripAdvisor' },
  { url: 'https://www.booking.com', category: '娱乐/生活', name: 'Booking.com' },

  // === 金融 ===
  { url: 'https://finance.yahoo.com', category: '金融', name: 'Yahoo Finance' },
  { url: 'https://www.investing.com', category: '金融', name: 'Investing.com' },
  { url: 'https://xueqiu.com', category: '金融', name: '雪球' },

  // === 教育 ===
  { url: 'https://www.coursera.org', category: '教育', name: 'Coursera' },
  { url: 'https://www.khanacademy.org', category: '教育', name: 'Khan Academy' },
];

// 工具函数
async function apiCall(method, path, body = undefined) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (method === 'POST' || method === 'PUT') {
    opts.body = JSON.stringify(body ?? {});
  }
  const resp = await fetch(`${BASE_URL}${path}`, opts);
  return resp.json();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

async function getServerMemory() {
  try {
    const resp = await fetch(`${BASE_URL}/v1/memory`);
    if (resp.ok) return await resp.json();
  } catch { /* ignore */ }
  return null;
}

// 主测试流程
async function main() {
  console.log('='.repeat(80));
  console.log('AI Browser 综合网站测试 & 内存分析');
  console.log('='.repeat(80));
  console.log(`测试站点数: ${TEST_SITES.length}`);
  console.log(`服务地址: ${BASE_URL}`);
  console.log(`开始时间: ${new Date().toLocaleString()}`);
  console.log('');

  // 检查服务是否在线
  try {
    const health = await apiCall('GET', '/health');
    console.log(`[OK] 服务健康检查: ${JSON.stringify(health)}`);
  } catch (e) {
    console.error('[FAIL] 无法连接服务，请先启动: npm run dev');
    process.exit(1);
  }

  // 获取初始服务端内存
  const serverMemStart = await getServerMemory();
  if (serverMemStart) {
    console.log(`[服务端内存-初始] RSS=${formatBytes(serverMemStart.rss)}, Heap=${formatBytes(serverMemStart.heapUsed)}/${formatBytes(serverMemStart.heapTotal)}`);
  }

  // 创建会话
  const createResult = await apiCall('POST', '/v1/sessions');
  const sessionId = createResult.sessionId;
  if (!sessionId) {
    console.error('[FAIL] 创建会话失败:', JSON.stringify(createResult));
    process.exit(1);
  }
  console.log(`\n[SESSION] 创建会话: ${sessionId}`);

  // 测试结果存储
  const results = [];
  const serverMemSnapshots = [];
  let successCount = 0;
  let failCount = 0;

  // 逐个测试网站
  for (let i = 0; i < TEST_SITES.length; i++) {
    const site = TEST_SITES[i];
    const index = i + 1;
    const prefix = `[${index}/${TEST_SITES.length}]`;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`${prefix} 测试: ${site.name} (${site.category})`);
    console.log(`       URL: ${site.url}`);

    const result = {
      name: site.name,
      url: site.url,
      category: site.category,
      success: false,
      navigateTime: 0,
      semanticTime: 0,
      contentTime: 0,
      totalTime: 0,
      pageType: '',
      pageTitle: '',
      elementCount: 0,
      linkCount: 0,
      imageCount: 0,
      textLength: 0,
      regionCount: 0,
      intentCount: 0,
      error: '',
    };

    const totalStart = Date.now();

    try {
      // 1. 导航到网站
      const navStart = Date.now();
      const navResult = await apiCall('POST', `/v1/sessions/${sessionId}/navigate`, { url: site.url });
      result.navigateTime = Date.now() - navStart;

      if (navResult.error) {
        throw new Error(navResult.error.message || JSON.stringify(navResult.error));
      }
      result.pageTitle = navResult.page?.title || '';
      console.log(`  [导航] ${formatDuration(result.navigateTime)} - ${result.pageTitle || '(无标题)'}`);

      // 2. 语义分析
      const semStart = Date.now();
      const semResult = await apiCall('GET', `/v1/sessions/${sessionId}/semantic`);
      result.semanticTime = Date.now() - semStart;

      if (semResult.error) {
        console.log(`  [语义] 失败: ${semResult.error.message}`);
      } else {
        result.pageType = semResult.page?.type || 'unknown';
        result.elementCount = semResult.elements?.length || 0;
        result.regionCount = semResult.regions?.length || 0;
        result.intentCount = semResult.intents?.length || 0;
        console.log(`  [语义] ${formatDuration(result.semanticTime)} - 类型: ${result.pageType}, 元素: ${result.elementCount}, 区域: ${result.regionCount}`);

        // 按类型统计元素
        if (semResult.elements && semResult.elements.length > 0) {
          const typeCount = {};
          for (const el of semResult.elements) {
            typeCount[el.type] = (typeCount[el.type] || 0) + 1;
          }
          const typeSummary = Object.entries(typeCount).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}:${c}`).join(', ');
          console.log(`         元素分布: ${typeSummary}`);

          // 显示前3个关键元素
          const topElements = semResult.elements.slice(0, 3);
          for (const el of topElements) {
            console.log(`         - ${el.id} (${el.type})`);
          }
          if (semResult.elements.length > 3) {
            console.log(`         ... 还有 ${semResult.elements.length - 3} 个`);
          }
        }

        if (semResult.intents && semResult.intents.length > 0) {
          console.log(`  [意图] ${semResult.intents.map(i => i.name).join(', ')}`);
        }
      }

      // 3. 内容提取
      const contentStart = Date.now();
      const contentResult = await apiCall('GET', `/v1/sessions/${sessionId}/content`);
      result.contentTime = Date.now() - contentStart;

      if (!contentResult.error) {
        result.linkCount = contentResult.links?.length || 0;
        result.imageCount = contentResult.images?.length || 0;
        result.textLength = contentResult.text?.length || 0;
        console.log(`  [内容] ${formatDuration(result.contentTime)} - 文本: ${result.textLength}字, 链接: ${result.linkCount}, 图片: ${result.imageCount}`);

        if (contentResult.text && contentResult.text.length > 0) {
          const preview = contentResult.text.substring(0, 120).replace(/\s+/g, ' ').trim();
          console.log(`         预览: "${preview}..."`);
        }
      }

      result.success = true;
      successCount++;
    } catch (err) {
      result.error = err.message || String(err);
      failCount++;
      console.log(`  [错误] ${result.error}`);
    }

    result.totalTime = Date.now() - totalStart;
    results.push(result);

    // 每5个站点采集服务端内存
    if (index % 5 === 0 || index === TEST_SITES.length) {
      const serverMem = await getServerMemory();
      if (serverMem) {
        serverMemSnapshots.push({
          siteIndex: index,
          siteName: site.name,
          ...serverMem,
        });
        console.log(`\n  [服务端内存 #${serverMemSnapshots.length}] RSS=${formatBytes(serverMem.rss)}, Heap=${formatBytes(serverMem.heapUsed)}/${formatBytes(serverMem.heapTotal)}, External=${formatBytes(serverMem.external)}`);
      }
    }
  }

  // 关闭会话
  await apiCall('DELETE', `/v1/sessions/${sessionId}`);
  console.log(`\n[SESSION] 会话已关闭`);

  // 关闭后再测一次内存
  const serverMemEnd = await getServerMemory();
  if (serverMemEnd) {
    console.log(`[服务端内存-清理后] RSS=${formatBytes(serverMemEnd.rss)}, Heap=${formatBytes(serverMemEnd.heapUsed)}`);
  }

  // ========== 生成报告 ==========
  console.log('\n' + '='.repeat(80));
  console.log('测试报告');
  console.log('='.repeat(80));

  console.log(`\n## 总体统计`);
  console.log(`总测试数: ${results.length}`);
  console.log(`成功: ${successCount} (${(successCount / results.length * 100).toFixed(1)}%)`);
  console.log(`失败: ${failCount} (${(failCount / results.length * 100).toFixed(1)}%)`);

  // 按分类统计
  console.log(`\n## 分类统计`);
  const categories = {};
  for (const r of results) {
    if (!categories[r.category]) {
      categories[r.category] = { total: 0, success: 0, fail: 0, sites: [] };
    }
    categories[r.category].total++;
    if (r.success) categories[r.category].success++;
    else categories[r.category].fail++;
    categories[r.category].sites.push(r);
  }

  for (const [cat, stats] of Object.entries(categories)) {
    console.log(`\n### ${cat} (${stats.success}/${stats.total} 成功)`);
    for (const site of stats.sites) {
      const status = site.success ? 'OK' : 'FAIL';
      const details = site.success
        ? `类型=${site.pageType}, 元素=${site.elementCount}, 链接=${site.linkCount}, 文本=${site.textLength}字, 耗时=${formatDuration(site.totalTime)}`
        : `错误: ${site.error}`;
      console.log(`  [${status}] ${site.name}: ${details}`);
    }
  }

  // 性能统计
  const successResults = results.filter(r => r.success);
  if (successResults.length > 0) {
    console.log(`\n## 性能统计 (仅成功站点, n=${successResults.length})`);

    const avg = (arr, fn) => arr.reduce((s, r) => s + fn(r), 0) / arr.length;
    const max = (arr, fn) => Math.max(...arr.map(fn));
    const min = (arr, fn) => Math.min(...arr.map(fn));

    console.log(`导航时间 - 平均: ${formatDuration(avg(successResults, r => r.navigateTime))}, 最大: ${formatDuration(max(successResults, r => r.navigateTime))}, 最小: ${formatDuration(min(successResults, r => r.navigateTime))}`);
    console.log(`语义分析 - 平均: ${formatDuration(avg(successResults, r => r.semanticTime))}, 最大: ${formatDuration(max(successResults, r => r.semanticTime))}, 最小: ${formatDuration(min(successResults, r => r.semanticTime))}`);
    console.log(`内容提取 - 平均: ${formatDuration(avg(successResults, r => r.contentTime))}, 最大: ${formatDuration(max(successResults, r => r.contentTime))}, 最小: ${formatDuration(min(successResults, r => r.contentTime))}`);
    console.log(`总耗时   - 平均: ${formatDuration(avg(successResults, r => r.totalTime))}, 最大: ${formatDuration(max(successResults, r => r.totalTime))}, 最小: ${formatDuration(min(successResults, r => r.totalTime))}`);
    console.log(`元素数量 - 平均: ${avg(successResults, r => r.elementCount).toFixed(0)}, 最大: ${max(successResults, r => r.elementCount)}, 最小: ${min(successResults, r => r.elementCount)}`);

    // Top 5 最慢
    const slowest = [...successResults].sort((a, b) => b.totalTime - a.totalTime).slice(0, 5);
    console.log(`\n### 最慢 Top 5`);
    for (const r of slowest) {
      console.log(`  ${r.name}: ${formatDuration(r.totalTime)} (导航=${formatDuration(r.navigateTime)}, 语义=${formatDuration(r.semanticTime)})`);
    }

    // Top 5 元素最多
    const mostElements = [...successResults].sort((a, b) => b.elementCount - a.elementCount).slice(0, 5);
    console.log(`\n### 元素最多 Top 5`);
    for (const r of mostElements) {
      console.log(`  ${r.name}: ${r.elementCount} 元素 (类型: ${r.pageType})`);
    }

    // Top 5 内容最多
    const mostContent = [...successResults].sort((a, b) => b.textLength - a.textLength).slice(0, 5);
    console.log(`\n### 文本最多 Top 5`);
    for (const r of mostContent) {
      console.log(`  ${r.name}: ${r.textLength}字 (链接: ${r.linkCount})`);
    }

    // 页面类型分布
    const pageTypeDist = {};
    for (const r of successResults) {
      pageTypeDist[r.pageType] = (pageTypeDist[r.pageType] || 0) + 1;
    }
    console.log(`\n### 页面类型识别分布`);
    for (const [type, count] of Object.entries(pageTypeDist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type}: ${count} (${(count / successResults.length * 100).toFixed(0)}%)`);
    }
  }

  // 服务端内存报告
  console.log(`\n## 服务端内存分析（Node.js进程）`);
  if (serverMemSnapshots.length > 0) {
    console.log('\n序号 | 站点名         | RSS        | Heap Used  | Heap Total | External');
    console.log('-'.repeat(80));
    for (const snap of serverMemSnapshots) {
      console.log(`  #${snap.siteIndex.toString().padStart(2)} | ${snap.siteName.padEnd(15)} | ${formatBytes(snap.rss).padStart(10)} | ${formatBytes(snap.heapUsed).padStart(10)} | ${formatBytes(snap.heapTotal).padStart(10)} | ${formatBytes(snap.external).padStart(10)}`);
    }

    if (serverMemSnapshots.length >= 2) {
      const first = serverMemSnapshots[0];
      const last = serverMemSnapshots[serverMemSnapshots.length - 1];
      const rssGrowth = last.rss - first.rss;
      const heapGrowth = last.heapUsed - first.heapUsed;
      console.log(`\n### 服务端内存增长（测试期间）`);
      console.log(`RSS: ${formatBytes(first.rss)} -> ${formatBytes(last.rss)} (增长 ${formatBytes(Math.abs(rssGrowth))}, ${rssGrowth >= 0 ? '+' : ''}${(rssGrowth / first.rss * 100).toFixed(1)}%)`);
      console.log(`Heap: ${formatBytes(first.heapUsed)} -> ${formatBytes(last.heapUsed)} (增长 ${formatBytes(Math.abs(heapGrowth))}, ${heapGrowth >= 0 ? '+' : ''}${(heapGrowth / first.heapUsed * 100).toFixed(1)}%)`);
    }

    if (serverMemEnd) {
      console.log(`\n### 会话关闭后内存`);
      console.log(`RSS=${formatBytes(serverMemEnd.rss)}, Heap=${formatBytes(serverMemEnd.heapUsed)}`);
      if (serverMemStart) {
        const netRss = serverMemEnd.rss - serverMemStart.rss;
        console.log(`与初始值相比 RSS 变化: ${netRss >= 0 ? '+' : ''}${formatBytes(Math.abs(netRss))}`);
      }
    }
  }

  // 失败站点
  const failedSites = results.filter(r => !r.success);
  if (failedSites.length > 0) {
    console.log(`\n## 失败站点 (${failedSites.length}个)`);
    for (const r of failedSites) {
      console.log(`  - ${r.name} (${r.url}): ${r.error}`);
    }
  }

  // 部署建议
  console.log(`\n## 部署配置建议`);
  if (serverMemSnapshots.length > 0) {
    const peakRss = Math.max(...serverMemSnapshots.map(s => s.rss));
    console.log(`Node.js 服务端峰值 RSS: ${formatBytes(peakRss)}`);
    console.log(`注意: 以上仅为 Node.js 进程内存，不含 Chromium 子进程。`);
    console.log(`Headless Chromium 基础内存约 200-400MB，每个Tab增加约 30-80MB。`);
    console.log(``);
    console.log(`建议配置:`);
    console.log(`  最低: 2核CPU, 2GB RAM - 支持1-2个session，每session 1-3个tab`);
    console.log(`  推荐: 4核CPU, 4GB RAM - 支持3-5个session，每session 3-5个tab`);
    console.log(`  生产: 8核CPU, 8GB RAM - 支持10+个session，支持复杂网页`);
  }

  console.log(`\n结束时间: ${new Date().toLocaleString()}`);
  console.log('='.repeat(80));

  // 保存JSON报告
  const report = {
    timestamp: new Date().toISOString(),
    totalSites: results.length,
    successCount,
    failCount,
    successRate: (successCount / results.length * 100).toFixed(1) + '%',
    results,
    serverMemorySnapshots: serverMemSnapshots,
    serverMemoryStart: serverMemStart,
    serverMemoryEnd: serverMemEnd,
  };

  const reportPath = path.join(__dirname, 'stress-test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n详细报告已保存: ${reportPath}`);
}

main().catch(console.error);
