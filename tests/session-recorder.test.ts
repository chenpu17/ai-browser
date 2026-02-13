import { describe, it, expect } from 'vitest';
import { SessionRecorder } from '../src/memory/SessionRecorder.js';

describe('SessionRecorder', () => {
  describe('lifecycle', () => {
    it('starts not recording', () => {
      const recorder = new SessionRecorder('sess-1');
      expect(recorder.isRecording()).toBe(false);
    });

    it('getStatus returns correct state when not recording', () => {
      const recorder = new SessionRecorder('sess-1');
      const status = recorder.getStatus();
      expect(status.recording).toBe(false);
      expect(status.eventCount).toBe(0);
      expect(status.domain).toBe('');
    });

    it('stopRecording returns null when not recording', () => {
      const recorder = new SessionRecorder('sess-1');
      expect(recorder.stopRecording()).toBeNull();
    });
  });

  // Note: Full integration tests with actual Puppeteer pages would require
  // a browser instance. These unit tests cover the class interface and state management.
  // Integration tests should be run separately with a real browser.
});
