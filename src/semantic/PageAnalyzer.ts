import { Page } from 'puppeteer-core';
import { PageType, Intent } from '../types/index.js';
import { safePageTitle } from '../utils/safe-page.js';

interface PageSignals {
  url: string;
  title: string;
  hasPasswordField: boolean;
  hasSearchInput: boolean;
  formCount: number;
  linkCount: number;
  listItemCount: number;
  textBlockCount: number;
}

export interface PageAnalysis {
  pageType: PageType;
  intents: Intent[];
  summary: string;
}

export class PageAnalyzer {
  async analyze(page: Page): Promise<PageAnalysis> {
    const signals = await this.collectSignals(page);
    const pageType = this.classifyPageType(signals);
    const intents = this.extractIntents(pageType, signals);
    const summary = this.generateSummary(pageType, signals);

    return { pageType, intents, summary };
  }

  private async collectSignals(page: Page): Promise<PageSignals> {
    const url = page.url();
    const title = await safePageTitle(page);

    const counts = await page.evaluate(() => {
      return {
        hasPasswordField: !!document.querySelector('input[type="password"]'),
        hasSearchInput: !!(
          document.querySelector('input[type="search"]') ||
          document.querySelector('input[name*="search"]') ||
          document.querySelector('input[name*="query"]') ||
          document.querySelector('input[name="q"]')
        ),
        formCount: document.querySelectorAll('form').length,
        linkCount: document.querySelectorAll('a').length,
        listItemCount: document.querySelectorAll('li').length,
        textBlockCount: document.querySelectorAll('p, article, section').length,
      };
    });

    return { url, title, ...counts };
  }

  private classifyPageType(signals: PageSignals): PageType {
    const { url, hasPasswordField, hasSearchInput, listItemCount, textBlockCount } = signals;
    const urlLower = url.toLowerCase();

    // URL模式匹配 (高权重)
    if (/\/(login|signin|sign-in)/.test(urlLower)) return PageType.LOGIN;
    if (/\/(register|signup|sign-up)/.test(urlLower)) return PageType.REGISTER;
    if (/\/(search|results)|\?q=/.test(urlLower)) return PageType.SEARCH_RESULTS;
    if (/\/(settings|preferences|config)/.test(urlLower)) return PageType.SETTINGS;
    if (/\/(checkout|payment|cart)/.test(urlLower)) return PageType.CHECKOUT;
    if (/\/(inbox|mail|messages)/.test(urlLower)) return PageType.EMAIL_INBOX;
    if (/\/(compose|new-message)/.test(urlLower)) return PageType.EMAIL_COMPOSE;
    if (/\/(dashboard|admin|panel)/.test(urlLower)) return PageType.DASHBOARD;

    // 表单特征 (高权重)
    if (hasPasswordField) {
      return signals.formCount === 1 ? PageType.LOGIN : PageType.FORM;
    }

    // 搜索引擎首页
    if (hasSearchInput && listItemCount < 10 && textBlockCount < 5) {
      return PageType.SEARCH_ENGINE;
    }

    // 元素统计 (中权重)
    if (listItemCount > 20) return PageType.LIST;
    if (textBlockCount > 10) return PageType.ARTICLE;

    return PageType.UNKNOWN;
  }

  private extractIntents(pageType: PageType, signals: PageSignals): Intent[] {
    const intents: Intent[] = [];

    switch (pageType) {
      case PageType.LOGIN:
        intents.push({
          name: 'login',
          description: '登录账户',
          requiredElements: ['input_username', 'input_password', 'btn_login'],
        });
        break;

      case PageType.SEARCH_ENGINE:
      case PageType.SEARCH_RESULTS:
        intents.push({
          name: 'search',
          description: '搜索内容',
          requiredElements: ['input_search', 'btn_search'],
        });
        if (pageType === PageType.SEARCH_RESULTS) {
          intents.push({
            name: 'select_result',
            description: '选择搜索结果',
            requiredElements: [],
          });
        }
        break;

      case PageType.FORM:
        intents.push({
          name: 'submit_form',
          description: '提交表单',
          requiredElements: [],
        });
        break;

      case PageType.ARTICLE:
        intents.push({
          name: 'read',
          description: '阅读文章',
          requiredElements: [],
        });
        break;

      case PageType.EMAIL_COMPOSE:
        intents.push({
          name: 'send_email',
          description: '发送邮件',
          requiredElements: ['input_to', 'input_subject', 'textarea_body', 'btn_send'],
        });
        break;
    }

    return intents;
  }

  private generateSummary(pageType: PageType, signals: PageSignals): string {
    const typeDescriptions: Record<PageType, string> = {
      [PageType.LOGIN]: '登录页面',
      [PageType.REGISTER]: '注册页面',
      [PageType.SEARCH_ENGINE]: '搜索引擎首页',
      [PageType.SEARCH_RESULTS]: '搜索结果页面',
      [PageType.FORM]: '表单页面',
      [PageType.ARTICLE]: '文章页面',
      [PageType.LIST]: '列表页面',
      [PageType.EMAIL_INBOX]: '邮件收件箱',
      [PageType.EMAIL_COMPOSE]: '邮件编写页面',
      [PageType.DASHBOARD]: '仪表盘页面',
      [PageType.SETTINGS]: '设置页面',
      [PageType.CHECKOUT]: '结账页面',
      [PageType.UNKNOWN]: '未知类型页面',
    };

    return `${typeDescriptions[pageType]} - ${signals.title}`;
  }
}
