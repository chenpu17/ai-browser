import { describe, it, expect } from 'vitest';
import { RecordingConverter } from '../src/memory/RecordingConverter.js';
import type { SessionRecording, RecordingEvent } from '../src/memory/SessionRecorder.js';

function makeRecording(events: RecordingEvent[], domain = 'example.com'): SessionRecording {
  return {
    id: 'rec-1',
    sessionId: 'sess-1',
    domain,
    events,
    startedAt: Date.now() - 10000,
    endedAt: Date.now(),
  };
}

describe('RecordingConverter', () => {
  describe('convert', () => {
    it('converts click events to selector patterns', () => {
      const events: RecordingEvent[] = [
        { type: 'click', timestamp: Date.now(), url: 'https://example.com/page', target: '.btn-submit', targetLabel: 'Submit' },
      ];
      const patterns = RecordingConverter.convert(makeRecording(events));
      expect(patterns.some(p => p.type === 'selector' && p.value === '.btn-submit')).toBe(true);
      expect(patterns.find(p => p.value === '.btn-submit')!.source).toBe('human_recording');
      expect(patterns.find(p => p.value === '.btn-submit')!.confidence).toBe(0.8);
    });

    it('converts navigation sequence to navigation_path', () => {
      const events: RecordingEvent[] = [
        { type: 'navigate', timestamp: Date.now(), url: 'https://example.com/a' },
        { type: 'navigate', timestamp: Date.now() + 1, url: 'https://example.com/b' },
      ];
      const patterns = RecordingConverter.convert(makeRecording(events));
      expect(patterns.some(p => p.type === 'navigation_path')).toBe(true);
    });

    it('converts form inputs to page_structure patterns', () => {
      const events: RecordingEvent[] = [
        { type: 'type', timestamp: Date.now(), url: 'https://example.com/form', target: '#search-input', targetLabel: 'Search', value: 'test' },
      ];
      const patterns = RecordingConverter.convert(makeRecording(events));
      expect(patterns.some(p => p.type === 'page_structure' && p.value === '#search-input')).toBe(true);
    });

    it('converts select events to page_structure patterns', () => {
      const events: RecordingEvent[] = [
        { type: 'select', timestamp: Date.now(), url: 'https://example.com/form', target: '#category', targetLabel: 'Category', value: 'tech' },
      ];
      const patterns = RecordingConverter.convert(makeRecording(events));
      expect(patterns.some(p => p.type === 'page_structure')).toBe(true);
    });

    it('deduplicates click targets', () => {
      const events: RecordingEvent[] = [
        { type: 'click', timestamp: Date.now(), url: 'https://example.com', target: '.btn', targetLabel: 'Click' },
        { type: 'click', timestamp: Date.now() + 1, url: 'https://example.com', target: '.btn', targetLabel: 'Click' },
      ];
      const patterns = RecordingConverter.convert(makeRecording(events));
      const btnPatterns = patterns.filter(p => p.value === '.btn');
      expect(btnPatterns).toHaveLength(1);
    });

    it('returns empty for empty recording', () => {
      const patterns = RecordingConverter.convert(makeRecording([]));
      expect(patterns).toHaveLength(0);
    });

    it('skips single navigation (no path)', () => {
      const events: RecordingEvent[] = [
        { type: 'navigate', timestamp: Date.now(), url: 'https://example.com/only' },
      ];
      const patterns = RecordingConverter.convert(makeRecording(events));
      expect(patterns.filter(p => p.type === 'navigation_path')).toHaveLength(0);
    });
  });

  describe('extractDomain', () => {
    it('extracts domain from recording domain field', () => {
      const recording = makeRecording([], 'www.bilibili.com');
      expect(RecordingConverter.extractDomain(recording)).toBe('bilibili.com');
    });

    it('falls back to first navigate event', () => {
      const events: RecordingEvent[] = [
        { type: 'navigate', timestamp: Date.now(), url: 'https://jd.com/products' },
      ];
      const recording = makeRecording(events, '');
      expect(RecordingConverter.extractDomain(recording)).toBe('jd.com');
    });

    it('returns empty for empty recording with no domain', () => {
      const recording = makeRecording([], '');
      expect(RecordingConverter.extractDomain(recording)).toBe('');
    });
  });
});
