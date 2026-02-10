import puppeteer, { Browser, Page } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

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
    if (!executablePath) {
      throw new Error(
        'Chrome/Chromium not found. Please set the CHROME_PATH environment variable to your Chrome executable path.\n' +
        '  Example (macOS):   export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n' +
        '  Example (Windows): set CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
        '  Example (Linux):   export CHROME_PATH=/usr/bin/google-chrome',
      );
    }
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
    const candidates = this.getChromeCandidates();
    const found = candidates.find(p => existsSync(p));
    if (found) return found;
    // Fallback: try system PATH via which/where
    try {
      const cmd = process.platform === 'win32' ? 'where chrome' : 'which google-chrome || which chromium-browser || which chromium';
      return execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
    } catch {
      return undefined;
    }
  }

  private getChromeCandidates(): string[] {
    const platform = process.platform;
    if (platform === 'darwin') {
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      ];
    }
    if (platform === 'win32') {
      const envDirs = [
        process.env.LOCALAPPDATA,
        process.env.PROGRAMFILES,
        process.env['PROGRAMFILES(X86)'],
      ].filter(Boolean) as string[];
      const suffixes = [
        '\\Google\\Chrome\\Application\\chrome.exe',
        '\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
      return envDirs.flatMap(dir => suffixes.map(s => dir + s));
    }
    // linux
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
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
