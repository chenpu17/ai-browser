import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { ElementCollector } from '../src/semantic/ElementCollector.js';

async function main() {
  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: false }); // 有头模式便于观察
  const sessionManager = new SessionManager(browserManager);
  const elementCollector = new ElementCollector();

  const session = await sessionManager.create();

  console.log('1. 导航到百度...');
  await session.page.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  console.log('2. 收集元素（会注入语义ID）...');
  const elements = await elementCollector.collect(session.page);
  console.log(`   收集到 ${elements.length} 个元素`);

  // 找到"新闻"链接
  const newsLink = elements.find(e => e.label === '新闻');
  if (newsLink) {
    console.log(`3. 找到新闻链接: ${newsLink.id}`);

    // 检查DOM中是否有这个语义ID
    const hasAttr = await session.page.evaluate((id) => {
      const el = document.querySelector(`[data-semantic-id="${id}"]`);
      if (el) {
        console.log('找到元素:', el.tagName, el.outerHTML.slice(0, 200));
        return { found: true, tag: el.tagName, href: (el as any).href };
      }
      return { found: false };
    }, newsLink.id);

    console.log('4. DOM检查结果:', hasAttr);

    if (hasAttr.found) {
      console.log('5. 尝试点击...');
      await session.page.click(`[data-semantic-id="${newsLink.id}"]`);
      await new Promise(r => setTimeout(r, 2000));
      console.log('6. 点击后URL:', session.page.url());
    }
  }

  // 保持浏览器打开10秒便于观察
  console.log('\n浏览器将在10秒后关闭...');
  await new Promise(r => setTimeout(r, 10000));

  await sessionManager.closeAll();
  await browserManager.close();
}

main().catch(console.error);
