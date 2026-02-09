import puppeteer, { Browser, Page } from 'puppeteer';

export interface BrowserOptions {
  headless?: boolean | 'new';
  viewport?: { width: number; height: number };
  userAgent?: string;
  timeout?: number;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export class BrowserManager {
  private headlessBrowser: Browser | null = null;
  private headfulBrowser: Browser | null = null;

  /** 默认 headless 模式（兼容旧调用） */
  async launch(options: BrowserOptions = {}): Promise<void> {
    const headless = options.headless ?? (process.env.HEADLESS === 'false' ? false : 'new');
    if (headless === false) {
      this.headfulBrowser = await this.launchInstance(false, options);
    } else {
      this.headlessBrowser = await this.launchInstance(headless, options);
    }
  }

  /** 判断是否为 headful 模式（headless === false） */
  private isHeadful(headless: boolean | 'new' | undefined): boolean {
    return headless === false;
  }

  /** 按需获取指定模式的浏览器实例，不存在则自动启动 */
  private async getBrowser(headless: boolean | 'new' | undefined): Promise<Browser> {
    if (this.isHeadful(headless)) {
      if (!this.headfulBrowser) {
        this.headfulBrowser = await this.launchInstance(false);
      }
      return this.headfulBrowser;
    }
    if (!this.headlessBrowser) {
      this.headlessBrowser = await this.launchInstance('new');
    }
    return this.headlessBrowser;
  }

  private async launchInstance(
    headless: boolean | 'new',
    options: BrowserOptions = {},
  ): Promise<Browser> {
    const executablePath = process.env.CHROME_PATH || this.detectChromePath();
    const proxyServer = process.env.PROXY_SERVER || '';

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      `--user-agent=${options.userAgent || DEFAULT_USER_AGENT}`,
    ];

    if (proxyServer) {
      args.push(`--proxy-server=${proxyServer}`);
    }

    return puppeteer.launch({ executablePath, headless, args });
  }

  private detectChromePath(): string | undefined {
    const platform = process.platform;
    const paths: Record<string, string> = {
      darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      linux: '/usr/bin/google-chrome',
    };
    return paths[platform];
  }

  async close(): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.headlessBrowser) {
      promises.push(this.headlessBrowser.close().then(() => { this.headlessBrowser = null; }));
    }
    if (this.headfulBrowser) {
      promises.push(this.headfulBrowser.close().then(() => { this.headfulBrowser = null; }));
    }
    await Promise.all(promises);
  }

  async newPage(options: BrowserOptions = {}): Promise<Page> {
    const browser = await this.getBrowser(options.headless);
    const page = await browser.newPage();
    if (options.viewport) {
      await page.setViewport(options.viewport);
    }
    if (options.userAgent) {
      await page.setUserAgent(options.userAgent);
    }
    return page;
  }

  isLaunched(): boolean {
    return this.headlessBrowser !== null || this.headfulBrowser !== null;
  }

  isHeadlessLaunched(): boolean {
    return this.headlessBrowser !== null;
  }

  isHeadfulLaunched(): boolean {
    return this.headfulBrowser !== null;
  }

  async closeHeadless(): Promise<void> {
    if (this.headlessBrowser) {
      await this.headlessBrowser.close();
      this.headlessBrowser = null;
    }
  }

  async closeHeadful(): Promise<void> {
    if (this.headfulBrowser) {
      await this.headfulBrowser.close();
      this.headfulBrowser = null;
    }
  }
}
