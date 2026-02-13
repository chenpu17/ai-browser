import type { RecordingEvent, SessionRecording } from './SessionRecorder.js';
import type { SitePattern } from './types.js';
import { MemoryCapturer } from './MemoryCapturer.js';

/**
 * Converts human session recordings into reusable SitePattern[].
 * Human-recorded patterns get higher initial confidence than agent-auto.
 */
export class RecordingConverter {
  static convert(recording: SessionRecording): SitePattern[] {
    const patterns: SitePattern[] = [];
    const now = Date.now();
    const seen = new Set<string>();

    // Extract navigation path from navigate events (deduplicate consecutive identical paths)
    const navEvents = recording.events.filter(e => e.type === 'navigate' && e.url);
    if (navEvents.length >= 2) {
      const paths: string[] = [];
      for (const e of navEvents) {
        try {
          const p = new URL(e.url).pathname;
          if (paths.length === 0 || paths[paths.length - 1] !== p) paths.push(p);
        } catch {
          const v = e.url;
          if (paths.length === 0 || paths[paths.length - 1] !== v) paths.push(v);
        }
      }
      if (paths.length >= 2) {
        const pathValue = paths.join(' → ');
        if (!seen.has(pathValue)) {
          seen.add(pathValue);
          patterns.push({
            type: 'navigation_path',
            description: `人类浏览路径: ${pathValue}`,
            value: pathValue,
            confidence: 0.8,
            useCount: 1,
            lastUsedAt: now,
            createdAt: now,
            source: 'human_recording',
          });
        }
      }
    }

    // Extract click targets as selector patterns
    const clickEvents = recording.events.filter(e => e.type === 'click' && e.target);
    for (const event of clickEvents) {
      const key = `click:${event.target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      patterns.push({
        type: 'selector',
        description: `点击目标: ${event.targetLabel || event.target}`,
        value: event.target!,
        urlPattern: this.extractPath(event.url),
        confidence: 0.8,
        useCount: 1,
        lastUsedAt: now,
        createdAt: now,
        source: 'human_recording',
      });
    }

    // Extract form inputs as page_structure patterns
    const inputEvents = recording.events.filter(e => (e.type === 'type' || e.type === 'select') && e.target);
    for (const event of inputEvents) {
      const key = `input:${event.target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      patterns.push({
        type: 'page_structure',
        description: event.targetLabel ? `表单字段: ${event.targetLabel}` : `输入字段 (${event.target})`,
        value: event.target!,
        urlPattern: this.extractPath(event.url),
        confidence: 0.8,
        useCount: 1,
        lastUsedAt: now,
        createdAt: now,
        source: 'human_recording',
      });
    }

    return patterns;
  }

  /**
   * Convert recording and save as knowledge card patterns.
   * Returns the domain extracted from the recording.
   */
  static extractDomain(recording: SessionRecording): string {
    if (recording.domain) {
      return MemoryCapturer.extractDomain(`https://${recording.domain}`);
    }
    // Try to extract from first navigate event
    const nav = recording.events.find(e => e.type === 'navigate' && e.url);
    if (nav) {
      return MemoryCapturer.extractDomain(nav.url);
    }
    return '';
  }

  private static extractPath(url: string): string | undefined {
    try {
      return new URL(url).pathname;
    } catch {
      return undefined;
    }
  }
}
