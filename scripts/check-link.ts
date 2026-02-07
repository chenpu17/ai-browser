import { BrowserManager } from '../src/browser/BrowserManager.js';

async function main() {
  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: true });
  const page = await browserManager.newPage();

  await page.goto('https://www.baidu.com', { waitUntil: 'domcontentloaded' });

  // 检查新闻链接的属性
  const linkInfo = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent?.includes('新闻')) {
        return {
          text: link.textContent,
          href: link.href,
          target: link.target,
          onclick: link.onclick?.toString().slice(0, 100),
        };
      }
    }
    return null;
  });

  console.log('新闻链接属性:', linkInfo);

  await browserManager.close();
}

main().catch(console.error);
