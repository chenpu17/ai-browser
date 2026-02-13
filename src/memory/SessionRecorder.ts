import type { Page } from 'puppeteer-core';

export interface RecordingEvent {
  type: 'navigate' | 'click' | 'type' | 'select' | 'scroll';
  timestamp: number;
  url: string;
  target?: string;        // CSS selector path
  targetLabel?: string;   // element text/label
  value?: string;         // input value (password fields filtered)
}

export interface SessionRecording {
  id: string;
  sessionId: string;
  domain: string;
  events: RecordingEvent[];
  startedAt: number;
  endedAt?: number;
}

const MAX_EVENTS = 500;
const RECORD_PREFIX = '__RECORD__:';

/** Shared JS injection script — used for both evaluateOnNewDocument and page.evaluate */
const RECORDER_SCRIPT = `(function() {
  if (window.__aiRecorderInjected) return;
  window.__aiRecorderInjected = true;

  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var current = el;
    for (var i = 0; i < 5 && current && current !== document.body; i++) {
      var tag = current.tagName.toLowerCase();
      if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
      var cls = current.className && typeof current.className === 'string'
        ? '.' + current.className.trim().split(/\\s+/).slice(0, 2).map(function(c) { return CSS.escape(c); }).join('.')
        : '';
      parts.unshift(tag + cls);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function getLabel(el) {
    var text = (el.textContent || '').trim().slice(0, 50);
    var aria = el.getAttribute('aria-label') || '';
    var placeholder = el.getAttribute('placeholder') || '';
    return aria || placeholder || text;
  }

  function isPassword(el) {
    return el.tagName === 'INPUT' && el.type === 'password';
  }

  function send(data) {
    if (!window.__aiRecorderActive) return;
    console.log('${RECORD_PREFIX}' + JSON.stringify(data));
  }

  document.addEventListener('click', function(e) {
    send({
      type: 'click',
      timestamp: Date.now(),
      url: location.href,
      target: getSelector(e.target),
      targetLabel: getLabel(e.target)
    });
  }, true);

  document.addEventListener('change', function(e) {
    var el = e.target;
    if (el.tagName === 'SELECT') {
      send({
        type: 'select',
        timestamp: Date.now(),
        url: location.href,
        target: getSelector(el),
        targetLabel: getLabel(el),
        value: el.value
      });
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      send({
        type: 'type',
        timestamp: Date.now(),
        url: location.href,
        target: getSelector(el),
        targetLabel: getLabel(el),
        value: isPassword(el) ? undefined : el.value
      });
    }
  }, true);

  var scrollTimer = null;
  document.addEventListener('scroll', function() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      send({
        type: 'scroll',
        timestamp: Date.now(),
        url: location.href,
        value: window.scrollY + ''
      });
    }, 500);
  }, true);
})();`;

/**
 * Records human browsing interactions via CDP event injection.
 * Captures click, input, select, and scroll events.
 * Password field values are never recorded.
 */
export class SessionRecorder {
  private recording: SessionRecording | null = null;
  private consoleHandler: ((msg: any) => void) | null = null;
  private frameHandler: ((frame: any) => void) | null = null;
  private page: Page | null = null;

  constructor(private sessionId: string) {}

  async startRecording(page: Page, recordingId: string): Promise<void> {
    if (this.recording) {
      throw new Error('Already recording');
    }

    this.page = page;
    let domain = '';
    try {
      domain = new URL(page.url()).hostname.replace(/^www\./, '');
    } catch { /* ok */ }

    this.recording = {
      id: recordingId,
      sessionId: this.sessionId,
      domain,
      events: [],
      startedAt: Date.now(),
    };

    // Inject for future navigations
    await page.evaluateOnNewDocument(RECORDER_SCRIPT);
    // Inject into current page + activate
    await page.evaluate(RECORDER_SCRIPT).catch(() => { /* page may not be ready */ });
    await page.evaluate('window.__aiRecorderActive = true').catch(() => {});

    // Listen for console messages with our prefix
    this.consoleHandler = (msg: any) => {
      if (!this.recording) return;
      const text = typeof msg.text === 'function' ? msg.text() : String(msg);
      if (!text.startsWith(RECORD_PREFIX)) return;
      if (this.recording.events.length >= MAX_EVENTS) return;

      try {
        const event = JSON.parse(text.slice(RECORD_PREFIX.length)) as RecordingEvent;
        this.recording.events.push(event);
        // Update domain from navigation events
        if (event.type === 'navigate' || (event.url && !this.recording.domain)) {
          try {
            this.recording.domain = new URL(event.url).hostname.replace(/^www\./, '');
          } catch { /* ok */ }
        }
      } catch { /* malformed event, skip */ }
    };
    page.on('console', this.consoleHandler);

    // Track navigations as events
    this.frameHandler = (frame: any) => {
      if (!this.recording) return;
      if (frame === page.mainFrame()) {
        if (this.recording.events.length < MAX_EVENTS) {
          this.recording.events.push({
            type: 'navigate',
            timestamp: Date.now(),
            url: frame.url(),
          });
        }
      }
    };
    page.on('framenavigated', this.frameHandler);
  }

  stopRecording(): SessionRecording | null {
    if (!this.recording) return null;
    this.recording.endedAt = Date.now();
    const result = this.recording;
    this.recording = null;

    // Deactivate injected script (it stays injected but stops sending)
    if (this.page) {
      this.page.evaluate('window.__aiRecorderActive = false').catch(() => {});
    }

    // Clean up listeners
    if (this.page) {
      if (this.consoleHandler) {
        this.page.removeListener('console', this.consoleHandler);
      }
      if (this.frameHandler) {
        this.page.removeListener('framenavigated', this.frameHandler);
      }
    }
    this.consoleHandler = null;
    this.frameHandler = null;
    this.page = null;

    return result;
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  getStatus(): { recording: boolean; eventCount: number; domain: string } {
    return {
      recording: this.recording !== null,
      eventCount: this.recording?.events.length || 0,
      domain: this.recording?.domain || '',
    };
  }
}
