import { Page, CDPSession } from 'puppeteer';
import { LoadState, PageState } from '../types/index.js';

interface InternalPageState {
  loadState: LoadState;
  pendingRequests: number;
  lastRequestTime: number;
  lastMutationTime: number;
  mutationCount: number;
  errors: string[];
}

interface ReadyConfig {
  quietWindowMs: number;
  maxWaitMs: number;
  allowPendingRequests: number;
}

const DEFAULT_CONFIG: ReadyConfig = {
  quietWindowMs: 500,
  maxWaitMs: 10000,
  allowPendingRequests: 2,
};

export class StateTracker {
  private state: InternalPageState;
  private client: CDPSession | null = null;
  private config: ReadyConfig;

  constructor(config: Partial<ReadyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createInitialState();
  }

  private createInitialState(): InternalPageState {
    return {
      loadState: LoadState.LOADING,
      pendingRequests: 0,
      lastRequestTime: Date.now(),
      lastMutationTime: Date.now(),
      mutationCount: 0,
      errors: [],
    };
  }

  async attach(page: Page): Promise<void> {
    this.client = await page.createCDPSession();
    this.state = this.createInitialState();

    await this.setupNetworkTracking();
    await this.setupDOMTracking();
    await this.setupLoadTracking(page);
  }

  async detach(): Promise<void> {
    if (this.client) {
      await this.client.detach();
      this.client = null;
    }
  }

  private async setupNetworkTracking(): Promise<void> {
    if (!this.client) return;

    await this.client.send('Network.enable');

    this.client.on('Network.requestWillBeSent', () => {
      this.state.pendingRequests++;
      this.state.lastRequestTime = Date.now();
    });

    this.client.on('Network.loadingFinished', () => {
      this.state.pendingRequests = Math.max(0, this.state.pendingRequests - 1);
    });

    this.client.on('Network.loadingFailed', () => {
      this.state.pendingRequests = Math.max(0, this.state.pendingRequests - 1);
    });
  }

  private async setupDOMTracking(): Promise<void> {
    if (!this.client) return;

    await this.client.send('DOM.enable');

    this.client.on('DOM.documentUpdated', () => {
      this.state.lastMutationTime = Date.now();
      this.state.mutationCount++;
    });

    this.client.on('DOM.childNodeInserted', () => {
      this.state.lastMutationTime = Date.now();
      this.state.mutationCount++;
    });

    this.client.on('DOM.childNodeRemoved', () => {
      this.state.lastMutationTime = Date.now();
      this.state.mutationCount++;
    });
  }

  private async setupLoadTracking(page: Page): Promise<void> {
    page.on('load', () => {
      this.state.loadState = LoadState.COMPLETE;
    });

    page.on('domcontentloaded', () => {
      if (this.state.loadState === LoadState.LOADING) {
        this.state.loadState = LoadState.INTERACTIVE;
      }
    });

    page.on('error', (err) => {
      this.state.errors.push(err.message);
    });
  }

  isReady(): boolean {
    const now = Date.now();
    const quietPeriod = now - this.state.lastMutationTime;

    const basicReady = this.state.loadState !== LoadState.LOADING;
    const domQuiet = quietPeriod >= this.config.quietWindowMs;
    const networkOk = this.state.pendingRequests <= this.config.allowPendingRequests;

    return basicReady && domQuiet && networkOk;
  }

  async waitForReady(): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.config.maxWaitMs) {
      if (this.isReady()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }

    return this.isReady();
  }

  getState(): PageState {
    return {
      loadState: this.state.loadState,
      isReady: this.isReady(),
      networkPending: this.state.pendingRequests,
      domStable: Date.now() - this.state.lastMutationTime >= this.config.quietWindowMs,
      modals: [],
      errors: this.state.errors,
    };
  }
}