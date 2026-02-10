import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Page, Dialog, CDPSession } from 'puppeteer-core';
import {
  DialogInfo,
  NetworkLogEntry,
  ConsoleLogEntry,
  DownloadInfo,
} from '../types/state.js';

export interface PageEventTrackerOptions {
  maxNetworkLogs?: number;
  maxConsoleLogs?: number;
  maxDialogs?: number;
  autoAcceptDialogs?: boolean;
  autoAcceptDelayMs?: number;
}

interface PendingRequest {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  startTime: number;
  headers?: Record<string, string>;
}

export interface StabilityState {
  stable: boolean;
  domStable: boolean;
  networkPending: number;
  loadState: 'loading' | 'domcontentloaded' | 'loaded';
}

export class PageEventTracker {
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;

  // Dialog tracking
  private dialogHistory: DialogInfo[] = [];
  private pendingDialog: { info: DialogInfo; dialog: Dialog } | null = null;
  private autoAcceptTimer: ReturnType<typeof setTimeout> | null = null;

  // Network tracking
  private networkLogs: NetworkLogEntry[] = [];
  private pendingRequests = new Map<string, PendingRequest>();

  // Console tracking
  private consoleLogs: ConsoleLogEntry[] = [];

  // DOM stability tracking
  private lastDomChangeTime = 0;
  private domMutationCount = 0;

  // Load state tracking
  private loadState: 'loading' | 'domcontentloaded' | 'loaded' = 'loading';

  // Popup tracking
  private popupPages: Page[] = [];

  // Download tracking
  private downloads: DownloadInfo[] = [];
  private downloadDir: string;

  // Options
  private readonly maxNetworkLogs: number;
  private readonly maxConsoleLogs: number;
  private readonly maxDialogs: number;
  private readonly autoAcceptDialogs: boolean;
  private readonly autoAcceptDelayMs: number;

  constructor(options: PageEventTrackerOptions = {}) {
    this.maxNetworkLogs = options.maxNetworkLogs ?? 200;
    this.maxConsoleLogs = options.maxConsoleLogs ?? 100;
    this.maxDialogs = options.maxDialogs ?? 20;
    this.autoAcceptDialogs = options.autoAcceptDialogs ?? true;
    this.autoAcceptDelayMs = options.autoAcceptDelayMs ?? 30000;
    this.downloadDir = path.join(os.tmpdir(), 'ai-browser-downloads', randomUUID());
  }

  async attach(page: Page): Promise<void> {
    this.page = page;
    this.setupDialogListener(page);
    this.setupPopupListener(page);
    this.setupConsoleListener(page);
    this.setupLoadStateListeners(page);

    try {
      this.cdpSession = await page.createCDPSession();
      await this.setupNetworkListeners(this.cdpSession);
      await this.setupDomStabilityListeners(this.cdpSession);
      await this.setupDownloadListeners(this.cdpSession);
    } catch {
      // CDP session creation may fail, non-critical
    }
  }

  async detach(): Promise<void> {
    if (this.autoAcceptTimer) {
      clearTimeout(this.autoAcceptTimer);
      this.autoAcceptTimer = null;
    }
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch {
        // ignore
      }
      this.cdpSession = null;
    }
    // Clean up download directory
    try {
      fs.rmSync(this.downloadDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    this.page = null;
  }

  // ===== Dialog methods =====

  private setupDialogListener(page: Page): void {
    page.on('dialog', async (dialog: Dialog) => {
      const info: DialogInfo = {
        id: `dlg_${randomUUID().slice(0, 8)}`,
        type: dialog.type() as DialogInfo['type'],
        message: dialog.message(),
        defaultValue: dialog.defaultValue() || undefined,
        timestamp: Date.now(),
        handled: false,
      };

      // Add to history (ring buffer)
      this.dialogHistory.push(info);
      if (this.dialogHistory.length > this.maxDialogs) {
        this.dialogHistory.shift();
      }

      this.pendingDialog = { info, dialog };

      if (this.autoAcceptDialogs) {
        this.autoAcceptTimer = setTimeout(async () => {
          if (this.pendingDialog && !this.pendingDialog.info.handled) {
            try {
              await dialog.accept(info.defaultValue);
              this.pendingDialog.info.handled = true;
              this.pendingDialog.info.response = true;
            } catch {
              // dialog may already be handled
            }
            this.pendingDialog = null;
          }
        }, this.autoAcceptDelayMs);
      }
    });
  }

  getPendingDialog(): DialogInfo | null {
    if (!this.pendingDialog || this.pendingDialog.info.handled) return null;
    return this.pendingDialog.info;
  }

  getDialogs(): DialogInfo[] {
    return [...this.dialogHistory];
  }

  async handleDialog(action: 'accept' | 'dismiss', text?: string): Promise<void> {
    if (!this.pendingDialog || this.pendingDialog.info.handled) {
      throw new Error('No pending dialog to handle');
    }

    // Cancel auto-accept timer
    if (this.autoAcceptTimer) {
      clearTimeout(this.autoAcceptTimer);
      this.autoAcceptTimer = null;
    }

    const { info, dialog } = this.pendingDialog;
    try {
      if (action === 'accept') {
        await dialog.accept(text ?? info.defaultValue);
        info.response = text ?? true;
      } else {
        await dialog.dismiss();
        info.response = false;
      }
    } catch {
      // dialog may already be handled
    }
    info.handled = true;
    this.pendingDialog = null;
  }

  // ===== Popup methods =====

  private setupPopupListener(page: Page): void {
    page.on('popup', (popup: Page | null) => {
      if (popup) {
        this.popupPages.push(popup);
        if (this.popupPages.length > 10) {
          this.popupPages.shift();
        }
      }
    });
  }

  getPopupPages(): Page[] {
    return [...this.popupPages];
  }

  clearPopupPages(): void {
    this.popupPages = [];
  }

  // ===== Console methods =====

  private setupConsoleListener(page: Page): void {
    page.on('console', (msg) => {
      const levelMap: Record<string, ConsoleLogEntry['level']> = {
        log: 'log',
        info: 'info',
        warn: 'warn',
        error: 'error',
        debug: 'debug',
        warning: 'warn',
      };
      const entry: ConsoleLogEntry = {
        level: levelMap[msg.type()] || 'log',
        text: msg.text(),
        timestamp: Date.now(),
        source: msg.location()?.url,
        lineNumber: msg.location()?.lineNumber,
      };
      this.consoleLogs.push(entry);
      if (this.consoleLogs.length > this.maxConsoleLogs) {
        this.consoleLogs.shift();
      }
    });
  }

  getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.consoleLogs];
  }

  // ===== Load state listeners =====

  private setupLoadStateListeners(page: Page): void {
    page.on('domcontentloaded', () => {
      if (this.loadState === 'loading') {
        this.loadState = 'domcontentloaded';
      }
    });
    page.on('load', () => {
      this.loadState = 'loaded';
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.loadState = 'loading';
        this.lastDomChangeTime = Date.now();
        this.domMutationCount = 0;
        this.pendingRequests.clear();
      }
    });
  }

  // ===== Network listeners =====

  private async setupNetworkListeners(cdp: CDPSession): Promise<void> {
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', (params: any) => {
      const req: PendingRequest = {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type || 'Other',
        startTime: Date.now(),
        headers: params.request.headers,
      };
      this.pendingRequests.set(params.requestId, req);
    });

    cdp.on('Network.responseReceived', (params: any) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (pending) {
        pending.resourceType = params.type || pending.resourceType;
        if (params.response) {
          (pending as any).status = params.response.status;
          (pending as any).statusText = params.response.statusText;
          (pending as any).responseHeaders = params.response.headers;
        }
      }
    });

    cdp.on('Network.loadingFinished', (params: any) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (!pending) return;
      this.pendingRequests.delete(params.requestId);

      const entry: NetworkLogEntry = {
        id: pending.id,
        url: pending.url,
        method: pending.method,
        status: (pending as any).status,
        statusText: (pending as any).statusText,
        resourceType: pending.resourceType,
        timing: {
          startTime: pending.startTime,
          endTime: Date.now(),
          duration: Date.now() - pending.startTime,
        },
        isXHR: pending.resourceType === 'XHR' || pending.resourceType === 'Fetch',
        headers: pending.headers,
        responseHeaders: (pending as any).responseHeaders,
        responseSize: params.encodedDataLength,
      };
      this.pushNetworkLog(entry);
    });

    cdp.on('Network.loadingFailed', (params: any) => {
      const pending = this.pendingRequests.get(params.requestId);
      if (!pending) return;
      this.pendingRequests.delete(params.requestId);

      const entry: NetworkLogEntry = {
        id: pending.id,
        url: pending.url,
        method: pending.method,
        resourceType: pending.resourceType,
        timing: {
          startTime: pending.startTime,
          endTime: Date.now(),
          duration: Date.now() - pending.startTime,
        },
        isXHR: pending.resourceType === 'XHR' || pending.resourceType === 'Fetch',
        headers: pending.headers,
        error: params.errorText || 'Loading failed',
      };
      this.pushNetworkLog(entry);
    });
  }

  private pushNetworkLog(entry: NetworkLogEntry): void {
    this.networkLogs.push(entry);
    if (this.networkLogs.length > this.maxNetworkLogs) {
      this.networkLogs.shift();
    }
  }

  getNetworkLogs(): NetworkLogEntry[] {
    return [...this.networkLogs];
  }

  // ===== DOM stability listeners =====

  private async setupDomStabilityListeners(cdp: CDPSession): Promise<void> {
    await cdp.send('DOM.enable');

    const onDomChange = () => {
      this.lastDomChangeTime = Date.now();
      this.domMutationCount++;
    };

    cdp.on('DOM.documentUpdated', onDomChange);
    cdp.on('DOM.childNodeInserted', onDomChange);
    cdp.on('DOM.childNodeRemoved', onDomChange);
  }

  /** Count pending requests, excluding long-lived ones (>10s) likely to be streaming/WebSocket */
  private getActiveRequestCount(): number {
    const now = Date.now();
    const LONG_LIVED_THRESHOLD = 10000;
    let count = 0;
    for (const req of this.pendingRequests.values()) {
      if (now - req.startTime < LONG_LIVED_THRESHOLD) {
        count++;
      }
    }
    return count;
  }

  isStable(quietMs?: number): boolean {
    const quiet = quietMs ?? 500;
    const now = Date.now();
    const domQuiet = (now - this.lastDomChangeTime) >= quiet;
    const networkIdle = this.getActiveRequestCount() === 0;
    return domQuiet && networkIdle && this.loadState !== 'loading';
  }

  async waitForStable(maxWaitMs?: number, quietMs?: number): Promise<boolean> {
    const maxWait = maxWaitMs ?? 5000;
    const quiet = quietMs ?? 500;
    const deadline = Date.now() + maxWait;

    while (Date.now() < deadline) {
      if (this.isStable(quiet)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return this.isStable(quiet);
  }

  getStabilityState(): StabilityState {
    return {
      stable: this.isStable(),
      domStable: (Date.now() - this.lastDomChangeTime) >= 500,
      networkPending: this.getActiveRequestCount(),
      loadState: this.loadState,
    };
  }

  // ===== Download listeners =====

  private async setupDownloadListeners(cdp: CDPSession): Promise<void> {
    // Ensure download directory exists
    try {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    } catch {
      // ignore
    }

    try {
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.downloadDir,
      });
    } catch {
      // Browser.setDownloadBehavior may not be available
      return;
    }

    cdp.on('Page.downloadWillBegin', (params: any) => {
      const info: DownloadInfo = {
        id: params.guid || randomUUID(),
        url: params.url,
        filename: params.suggestedFilename || 'unknown',
        path: path.join(this.downloadDir, params.suggestedFilename || 'unknown'),
        completed: false,
      };
      this.downloads.push(info);
      if (this.downloads.length > 50) {
        this.downloads.shift();
      }
    });

    cdp.on('Page.downloadProgress', (params: any) => {
      const dl = this.downloads.find(d => d.id === params.guid);
      if (!dl) return;
      if (params.state === 'completed') {
        dl.completed = true;
        dl.size = params.totalBytes;
      } else if (params.state === 'canceled') {
        dl.error = 'Download canceled';
      }
    });
  }

  getDownloads(): DownloadInfo[] {
    return [...this.downloads];
  }
}
