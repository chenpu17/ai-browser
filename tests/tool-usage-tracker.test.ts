import { describe, it, expect } from 'vitest';
import { ToolUsageTracker } from '../src/agent/tool-usage-tracker.js';

describe('ToolUsageTracker', () => {
  function makeCall(toolName: string, args: Record<string, any> = {}, success = true) {
    return { toolName, args, success, timestamp: Date.now() };
  }

  describe('record and getCallCount', () => {
    it('tracks total call count', () => {
      const tracker = new ToolUsageTracker();
      tracker.record(makeCall('click'));
      tracker.record(makeCall('type_text'));
      expect(tracker.getCallCount()).toBe(2);
    });

    it('tracks per-tool call count', () => {
      const tracker = new ToolUsageTracker();
      tracker.record(makeCall('click'));
      tracker.record(makeCall('click'));
      tracker.record(makeCall('type_text'));
      expect(tracker.getCallCount('click')).toBe(2);
      expect(tracker.getCallCount('type_text')).toBe(1);
    });
  });

  describe('getErrorRate', () => {
    it('returns 0 for no calls', () => {
      const tracker = new ToolUsageTracker();
      expect(tracker.getErrorRate()).toBe(0);
    });

    it('calculates error rate correctly', () => {
      const tracker = new ToolUsageTracker();
      tracker.record(makeCall('click', {}, true));
      tracker.record(makeCall('click', {}, false));
      expect(tracker.getErrorRate()).toBe(0.5);
      expect(tracker.getErrorRate('click')).toBe(0.5);
    });
  });

  describe('detectLoop', () => {
    it('returns null when not enough calls', () => {
      const tracker = new ToolUsageTracker();
      tracker.record(makeCall('click', { id: 'a' }));
      expect(tracker.detectLoop()).toBeNull();
    });

    it('detects 3 identical calls', () => {
      const tracker = new ToolUsageTracker();
      const args = { element_id: 'btn_1' };
      tracker.record(makeCall('click', args));
      tracker.record(makeCall('click', args));
      tracker.record(makeCall('click', args));
      const result = tracker.detectLoop();
      expect(result).not.toBeNull();
      expect(result!.type).toBe('exact_repeat');
    });

    it('returns null for different calls', () => {
      const tracker = new ToolUsageTracker();
      tracker.record(makeCall('click', { id: 'a' }));
      tracker.record(makeCall('click', { id: 'b' }));
      tracker.record(makeCall('click', { id: 'a' }));
      expect(tracker.detectLoop()).toBeNull();
    });
  });

  describe('detectOscillation', () => {
    it('detects A-B-A-B-A-B pattern', () => {
      const tracker = new ToolUsageTracker();
      const argsA = { id: 'a' };
      const argsB = { id: 'b' };
      for (let i = 0; i < 6; i++) {
        tracker.record(makeCall(i % 2 === 0 ? 'click' : 'get_page_info', i % 2 === 0 ? argsA : argsB));
      }
      const result = tracker.detectOscillation();
      expect(result).not.toBeNull();
      expect(result!.type).toBe('oscillation');
    });

    it('returns null for non-oscillating pattern', () => {
      const tracker = new ToolUsageTracker();
      for (let i = 0; i < 6; i++) {
        tracker.record(makeCall('click', { id: `el_${i}` }));
      }
      expect(tracker.detectOscillation()).toBeNull();
    });
  });

  describe('detectFutileRetry', () => {
    it('detects repeated failures with same args', () => {
      const tracker = new ToolUsageTracker();
      const args = { element_id: 'missing_btn' };
      tracker.record(makeCall('click', args, false));
      tracker.record(makeCall('click', args, false));
      const result = tracker.detectFutileRetry();
      expect(result).not.toBeNull();
      expect(result!.type).toBe('futile_retry');
    });

    it('returns null when last call succeeded', () => {
      const tracker = new ToolUsageTracker();
      const args = { element_id: 'btn' };
      tracker.record(makeCall('click', args, false));
      tracker.record(makeCall('click', args, true));
      expect(tracker.detectFutileRetry()).toBeNull();
    });
  });

  describe('detectProgressStall', () => {
    it('detects observation-only stall', () => {
      const tracker = new ToolUsageTracker();
      for (let i = 0; i < 5; i++) {
        tracker.record(makeCall('get_page_info'));
      }
      const result = tracker.detectProgressStall();
      expect(result).not.toBeNull();
      expect(result!.type).toBe('progress_stall');
    });

    it('returns null when navigation tools are used', () => {
      const tracker = new ToolUsageTracker();
      for (let i = 0; i < 4; i++) {
        tracker.record(makeCall('get_page_info'));
      }
      tracker.record(makeCall('click', { id: 'btn' }));
      expect(tracker.detectProgressStall()).toBeNull();
    });
  });

  describe('summarize', () => {
    it('returns empty message for no calls', () => {
      const tracker = new ToolUsageTracker();
      expect(tracker.summarize()).toContain('无工具调用记录');
    });

    it('summarizes tool usage', () => {
      const tracker = new ToolUsageTracker();
      tracker.record(makeCall('click', {}, true));
      tracker.record(makeCall('click', {}, false));
      tracker.record(makeCall('type_text', {}, true));
      const summary = tracker.summarize();
      expect(summary).toContain('共 3 次');
      expect(summary).toContain('click×2');
      expect(summary).toContain('1 失败');
    });
  });
});
