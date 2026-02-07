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
  private browser: Browser | null = null;

  async launch(options: BrowserOptions = {}): Promise<void> {
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

    this.browser = await puppeteer.launch({
      executablePath,
      headless: options.headless ?? (process.env.HEADLESS === 'false' ? false : 'new'),
      args,
    });
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
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async newPage(options: BrowserOptions = {}): Promise<Page> {
    if (!this.browser) {
      throw new Error('Browser not launched');
    }
    const page = await this.browser.newPage();
    if (options.viewport) {
      await page.setViewport(options.viewport);
    }
    if (options.userAgent) {
      await page.setUserAgent(options.userAgent);
    }
    return page;
  }

  isLaunched(): boolean {
    return this.browser !== null;
  }
}
