import { describe, it, expect } from 'vitest';
import { ProgressEstimator } from '../src/agent/progress-estimator.js';

describe('ProgressEstimator', () => {
  it('starts at 0% with navigating phase', () => {
    const est = new ProgressEstimator();
    const info = est.estimate();
    expect(info.phase).toBe('navigating');
    expect(info.percent).toBe(0);
  });

  it('reports navigating phase after navigate', () => {
    const est = new ProgressEstimator();
    const info = est.record('navigate');
    expect(info.phase).toBe('navigating');
    expect(info.percent).toBeGreaterThan(0);
  });

  it('reports observing phase after get_page_info', () => {
    const est = new ProgressEstimator();
    est.record('navigate');
    const info = est.record('get_page_info');
    expect(info.phase).toBe('observing');
    expect(info.percent).toBeGreaterThanOrEqual(10);
  });

  it('reports acting phase after click', () => {
    const est = new ProgressEstimator();
    est.record('navigate');
    est.record('get_page_info');
    const info = est.record('click');
    expect(info.phase).toBe('acting');
    expect(info.percent).toBeGreaterThanOrEqual(15);
  });

  it('reports extracting phase on second content call after acting', () => {
    const est = new ProgressEstimator();
    est.record('navigate');
    est.record('get_page_content');
    est.record('click');
    const info = est.record('get_page_content');
    expect(info.phase).toBe('extracting');
    expect(info.percent).toBeGreaterThanOrEqual(20);
  });

  it('reports 100% after done', () => {
    const est = new ProgressEstimator();
    est.record('navigate');
    est.record('get_page_info');
    est.record('click');
    const info = est.record('done');
    expect(info.phase).toBe('completing');
    expect(info.percent).toBe(100);
    expect(info.stepsRemaining).toBe(0);
  });

  it('never exceeds 99% before done', () => {
    const est = new ProgressEstimator(5);
    est.record('navigate');
    est.record('get_page_info');
    est.record('click');
    est.record('get_page_content');
    const info = est.record('get_page_content');
    expect(info.percent).toBeLessThanOrEqual(99);
  });

  it('estimates steps remaining', () => {
    const est = new ProgressEstimator();
    est.record('navigate');
    const info = est.record('get_page_info');
    expect(info.stepsRemaining).toBeGreaterThan(0);
  });

  it('handles composite tools correctly', () => {
    const est = new ProgressEstimator();
    const info = est.record('navigate_and_extract');
    expect(info.phase).toBe('navigating');
  });
});
