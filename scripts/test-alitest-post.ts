/**
 * AliTest 网站发帖功能测试
 * 测试语义元素识别和操作执行
 */

import { BrowserManager } from '../src/browser/BrowserManager.js';
import { SessionManager } from '../src/browser/SessionManager.js';
import { ElementCollector } from '../src/semantic/ElementCollector.js';
import { PageAnalyzer } from '../src/semantic/PageAnalyzer.js';
import { ElementMatcher } from '../src/semantic/ElementMatcher.js';

const ALITEST_URL = 'http://ali.chenpu.fun:13478';

async function main() {
  console.log('='.repeat(60));
  console.log('AliTest 发帖功能测试');
  console.log('='.repeat(60));
  console.log(`目标网站: ${ALITEST_URL}`);
  console.log('');

  const browserManager = new BrowserManager();
  await browserManager.launch({ headless: true }); // 使用无头模式
  const sessionManager = new SessionManager(browserManager);
  const elementCollector = new ElementCollector();
  const pageAnalyzer = new PageAnalyzer();
  const elementMatcher = new ElementMatcher();

  try {
    // 1. 创建会话并导航
    console.log('[1] 创建会话并导航到网站...');
    const session = await sessionManager.create();
    await session.page.goto(ALITEST_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 2000));
    console.log('  ✓ 导航成功');

    // 2. 分析页面
    console.log('\n[2] 分析页面结构...');
    const analysis = await pageAnalyzer.analyze(session.page);
    console.log(`  页面类型: ${analysis.pageType}`);
    console.log(`  页面摘要: ${analysis.summary}`);
    console.log(`  可用意图: ${analysis.intents.map((i) => i.name).join(', ')}`);

    // 3. 收集元素
    console.log('\n[3] 收集语义元素...');
    const elements = await elementCollector.collect(session.page);
    console.log(`  共收集 ${elements.length} 个元素`);

    // 按类型分组统计
    const typeCount: Record<string, number> = {};
    for (const el of elements) {
      typeCount[el.type] = (typeCount[el.type] || 0) + 1;
    }
    console.log('  元素类型分布:');
    for (const [type, count] of Object.entries(typeCount)) {
      console.log(`    - ${type}: ${count}`);
    }

    // 4. 查找发帖相关元素
    console.log('\n[4] 查找发帖相关元素...');
    const postKeywords = ['发帖', '发布', '新帖', 'post', 'new', '写', '创建'];
    for (const keyword of postKeywords) {
      const matches = elementMatcher.findByQuery(elements, keyword, 3);
      if (matches.length > 0) {
        console.log(`  关键词 "${keyword}" 匹配结果:`);
        for (const m of matches) {
          console.log(`    - [${m.element.type}] ${m.element.label} (ID: ${m.element.id}, 分数: ${m.score.toFixed(2)})`);
        }
      }
    }

    // 5. 查找输入框
    console.log('\n[5] 查找输入框元素...');
    const inputElements = elements.filter(
      (el) => el.type === 'input' || el.type === 'textarea' || el.type === 'textbox'
    );
    console.log(`  找到 ${inputElements.length} 个输入框:`);
    for (const el of inputElements.slice(0, 10)) {
      console.log(`    - ${el.label || '(无标签)'} (ID: ${el.id}, type: ${el.type})`);
    }

    // 6. 查找按钮
    console.log('\n[6] 查找按钮元素...');
    const buttonElements = elements.filter((el) => el.type === 'button');
    console.log(`  找到 ${buttonElements.length} 个按钮:`);
    for (const el of buttonElements.slice(0, 10)) {
      console.log(`    - ${el.label || '(无标签)'} (ID: ${el.id})`);
    }

    // 7. 查找链接
    console.log('\n[7] 查找链接元素...');
    const linkElements = elements.filter((el) => el.type === 'link');
    console.log(`  找到 ${linkElements.length} 个链接:`);
    for (const el of linkElements.slice(0, 15)) {
      console.log(`    - ${el.label || '(无标签)'} (ID: ${el.id})`);
    }

    // 8. 截图保存
    console.log('\n[8] 保存页面截图...');
    await session.page.screenshot({
      path: 'scripts/alitest-screenshot.png',
      fullPage: false,
    });
    console.log('  ✓ 截图已保存到 scripts/alitest-screenshot.png');

    // 9. 尝试发帖操作
    console.log('\n[9] 尝试发帖操作...');
    const submitBtn = elements.find((el) => el.label === '提交留言');
    if (submitBtn && inputElements.length > 0) {
      console.log('  找到提交按钮和输入框，尝试发帖...');

      // 查找文本输入区域
      const textInput = inputElements[0];
      console.log(`  目标输入框: ${textInput.id}`);

      // 使用 CDP 方式输入
      const testMessage = `AI Browser 自动化测试 - ${new Date().toISOString()}`;
      try {
        // 尝试通过 data-semantic-id 定位
        const selector = `[data-semantic-id="${textInput.id}"]`;
        await session.page.waitForSelector(selector, { timeout: 5000 });
        await session.page.click(selector);
        await session.page.type(selector, testMessage);
        console.log(`  ✓ 已输入测试内容: ${testMessage}`);

        // 截图输入后状态
        await session.page.screenshot({
          path: 'scripts/alitest-after-input.png',
          fullPage: false,
        });
        console.log('  ✓ 输入后截图已保存');

        // 点击提交按钮
        const submitSelector = `[data-semantic-id="${submitBtn.id}"]`;
        await session.page.click(submitSelector);
        console.log('  ✓ 已点击提交按钮');

        // 等待页面响应
        await new Promise((r) => setTimeout(r, 3000));

        // 截图提交后状态
        await session.page.screenshot({
          path: 'scripts/alitest-after-submit.png',
          fullPage: false,
        });
        console.log('  ✓ 提交后截图已保存');
      } catch (err: any) {
        console.log(`  ✗ 发帖操作失败: ${err.message}`);
      }
    } else {
      console.log('  未找到完整的发帖表单元素');
    }

    // 清理
    await sessionManager.close(session.id);
    console.log('\n测试完成!');
  } catch (err: any) {
    console.error('测试失败:', err.message);
  } finally {
    await sessionManager.closeAll();
    await browserManager.close();
  }
}

main().catch(console.error);
