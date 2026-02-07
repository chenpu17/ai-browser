/**
 * 实际网站测试脚本
 * 测试20个网站的语义提取、页面分析等功能
 */

import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { ElementCollector } from '../src/semantic/ElementCollector.js';
import { PageAnalyzer } from '../src/semantic/PageAnalyzer.js';
import { ContentExtractor } from '../src/semantic/ContentExtractor.js';
import { RegionDetector } from '../src/semantic/RegionDetector.js';

const TEST_SITES = [
  // 搜索引擎
  { url: 'https://www.baidu.com', name: 'Baidu' },
  { url: 'https://www.bing.com', name: 'Bing' },
  { url: 'https://www.sogou.com', name: 'Sogou' },
  // 技术网站
  { url: 'https://stackoverflow.com', name: 'StackOverflow' },
  { url: 'https://www.zhihu.com', name: 'Zhihu' },
  { url: 'https://juejin.cn', name: 'Juejin' },
  // 信息/工具
  { url: 'https://example.com', name: 'Example' },
  { url: 'https://httpbin.org', name: 'HTTPBin' },
  // 电商
  { url: 'https://www.taobao.com', name: 'Taobao' },
  { url: 'https://www.jd.com', name: 'JD' },
  // 视频
  { url: 'https://www.bilibili.com', name: 'Bilibili' },
  { url: 'https://www.iqiyi.com', name: 'iQiyi' },
  // 新闻
  { url: 'https://www.sina.com.cn', name: 'Sina' },
  { url: 'https://www.163.com', name: 'NetEase' },
  // 工具/云服务
  { url: 'https://www.cloudflare.com', name: 'Cloudflare' },
  { url: 'https://www.npmjs.com', name: 'NPM' },
  // 其他
  { url: 'https://www.apple.com', name: 'Apple' },
  { url: 'https://www.microsoft.com', name: 'Microsoft' },
  { url: 'https://www.douban.com', name: 'Douban' },
  // 用户指定的测试网站
  { url: 'http://ali.chenpu.fun:13478', name: 'AliTest' },
];

interface TestResult {
  site: string;
  url: string;
  success: boolean;
  pageType?: string;
  elementCount?: number;
  regionCount?: number;
  title?: string;
  error?: string;
  duration?: number;
}

async function testSite(
  session: any,
  site: { url: string; name: string },
  collectors: {
    elementCollector: ElementCollector;
    pageAnalyzer: PageAnalyzer;
    contentExtractor: ContentExtractor;
    regionDetector: RegionDetector;
  }
): Promise<TestResult> {
  const start = Date.now();
  try {
    await session.page.goto(site.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // 额外等待确保动态内容加载
    await new Promise((r) => setTimeout(r, 500));

    const [elements, analysis, regions, content] = await Promise.all([
      collectors.elementCollector.collect(session.page),
      collectors.pageAnalyzer.analyze(session.page),
      collectors.regionDetector.detect(session.page),
      collectors.contentExtractor.extract(session.page),
    ]);

    return {
      site: site.name,
      url: site.url,
      success: true,
      pageType: analysis.pageType,
      elementCount: elements.length,
      regionCount: regions.length,
      title: content.title,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      site: site.name,
      url: site.url,
      success: false,
      error: err.message,
      duration: Date.now() - start,
    };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('AI Browser 实际网站测试');
  console.log('='.repeat(60));
  console.log(`测试网站数量: ${TEST_SITES.length}`);
  console.log('');

  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: true });
  const sessionManager = new SessionManager(browserManager);

  const collectors = {
    elementCollector: new ElementCollector(),
    pageAnalyzer: new PageAnalyzer(),
    contentExtractor: new ContentExtractor(),
    regionDetector: new RegionDetector(),
  };

  const results: TestResult[] = [];

  for (let i = 0; i < TEST_SITES.length; i++) {
    const site = TEST_SITES[i];
    console.log(`[${i + 1}/${TEST_SITES.length}] 测试 ${site.name}...`);

    const session = await sessionManager.create();
    const result = await testSite(session, site, collectors);
    results.push(result);

    if (result.success) {
      console.log(`  ✓ 成功 | 类型: ${result.pageType} | 元素: ${result.elementCount} | 区域: ${result.regionCount} | ${result.duration}ms`);
    } else {
      console.log(`  ✗ 失败 | ${result.error}`);
    }

    await sessionManager.close(session.id);
  }

  // 输出汇总
  console.log('');
  console.log('='.repeat(60));
  console.log('测试汇总');
  console.log('='.repeat(60));

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  console.log(`成功: ${successCount}/${TEST_SITES.length}`);
  console.log(`失败: ${failCount}/${TEST_SITES.length}`);
  console.log('');

  // 详细结果表格
  console.log('详细结果:');
  console.log('-'.repeat(80));
  console.log('网站'.padEnd(15) + '状态'.padEnd(8) + '类型'.padEnd(18) + '元素'.padEnd(8) + '耗时');
  console.log('-'.repeat(80));

  for (const r of results) {
    const status = r.success ? '✓' : '✗';
    const type = r.pageType || '-';
    const elements = r.elementCount?.toString() || '-';
    const duration = r.duration ? `${r.duration}ms` : '-';
    console.log(`${r.site.padEnd(15)}${status.padEnd(8)}${type.padEnd(18)}${elements.padEnd(8)}${duration}`);
  }

  await sessionManager.closeAll();
  await browserManager.close();

  console.log('');
  console.log('测试完成!');
}

main().catch(console.error);
