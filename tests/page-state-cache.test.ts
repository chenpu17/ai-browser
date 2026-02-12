import { describe, it, expect } from 'vitest';
import { PageStateCache } from '../src/agent/page-state-cache.js';

describe('PageStateCache', () => {
  it('returns isNewPage=true on first call', () => {
    const cache = new PageStateCache();
    const diff = cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'OK' },
    ], 'https://example.com');
    expect(diff.isNewPage).toBe(true);
    expect(diff.added.length).toBe(1);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0);
  });

  it('returns isNewPage=true when URL changes', () => {
    const cache = new PageStateCache();
    cache.update('s1', [{ id: 'btn_1', type: 'button', label: 'OK' }], 'https://a.com');
    const diff = cache.update('s1', [{ id: 'btn_2', type: 'button', label: 'Go' }], 'https://b.com');
    expect(diff.isNewPage).toBe(true);
  });

  it('detects added elements on same page', () => {
    const cache = new PageStateCache();
    cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'OK' },
      { id: 'btn_2', type: 'button', label: 'Cancel' },
      { id: 'btn_3', type: 'link', label: 'Home' },
    ], 'https://example.com');
    const diff = cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'OK' },
      { id: 'btn_2', type: 'button', label: 'Cancel' },
      { id: 'btn_3', type: 'link', label: 'Home' },
      { id: 'btn_4', type: 'button', label: 'New' },
    ], 'https://example.com');
    expect(diff.isNewPage).toBe(false);
    expect(diff.added.length).toBe(1);
    expect(diff.added[0].id).toBe('btn_4');
    expect(diff.unchangedCount).toBe(3);
  });

  it('detects removed elements on same page', () => {
    const cache = new PageStateCache();
    cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'OK' },
      { id: 'btn_2', type: 'button', label: 'Cancel' },
    ], 'https://example.com');
    const diff = cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'OK' },
    ], 'https://example.com');
    expect(diff.isNewPage).toBe(false);
    expect(diff.removed).toEqual(['btn_2']);
    expect(diff.unchangedCount).toBe(1);
  });

  it('detects changed elements by label', () => {
    const cache = new PageStateCache();
    cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'OK' },
      { id: 'btn_2', type: 'button', label: 'Cancel' },
      { id: 'btn_3', type: 'link', label: 'Home' },
    ], 'https://example.com');
    const diff = cache.update('s1', [
      { id: 'btn_1', type: 'button', label: 'Submit' },
      { id: 'btn_2', type: 'button', label: 'Cancel' },
      { id: 'btn_3', type: 'link', label: 'Home' },
    ], 'https://example.com');
    expect(diff.isNewPage).toBe(false);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0].label).toBe('Submit');
  });

  it('detects changed elements by state', () => {
    const cache = new PageStateCache();
    cache.update('s1', [
      { id: 'input_1', type: 'input', label: 'Name', state: { value: '' } },
      { id: 'input_2', type: 'input', label: 'Email', state: { value: 'a@b.com' } },
      { id: 'btn_1', type: 'button', label: 'Submit' },
    ], 'https://example.com');
    const diff = cache.update('s1', [
      { id: 'input_1', type: 'input', label: 'Name', state: { value: 'Alice' } },
      { id: 'input_2', type: 'input', label: 'Email', state: { value: 'a@b.com' } },
      { id: 'btn_1', type: 'button', label: 'Submit' },
    ], 'https://example.com');
    expect(diff.isNewPage).toBe(false);
    expect(diff.changed.length).toBe(1);
  });

  it('falls back to full list when >50% elements change', () => {
    const cache = new PageStateCache();
    const original = Array.from({ length: 10 }, (_, i) => ({
      id: `el_${i}`, type: 'button', label: `Btn ${i}`,
    }));
    cache.update('s1', original, 'https://example.com');
    // Replace 6 out of 10 elements (>50%)
    const updated = original.slice(0, 4).concat(
      Array.from({ length: 6 }, (_, i) => ({
        id: `new_${i}`, type: 'button', label: `New ${i}`,
      }))
    );
    const diff = cache.update('s1', updated, 'https://example.com');
    expect(diff.isNewPage).toBe(true);
  });

  it('returns no changes when page is identical', () => {
    const cache = new PageStateCache();
    const elements = [
      { id: 'btn_1', type: 'button', label: 'OK' },
      { id: 'btn_2', type: 'link', label: 'Home' },
    ];
    cache.update('s1', elements, 'https://example.com');
    const diff = cache.update('s1', elements, 'https://example.com');
    expect(diff.isNewPage).toBe(false);
    expect(diff.added.length).toBe(0);
    expect(diff.removed.length).toBe(0);
    expect(diff.changed.length).toBe(0);
    expect(diff.unchangedCount).toBe(2);
  });

  it('isolates sessions from each other', () => {
    const cache = new PageStateCache();
    cache.update('s1', [{ id: 'a', type: 'button', label: 'A' }], 'https://example.com');
    const diff = cache.update('s2', [{ id: 'b', type: 'button', label: 'B' }], 'https://example.com');
    // s2 is first call → new page
    expect(diff.isNewPage).toBe(true);
  });

  it('clear removes session snapshot', () => {
    const cache = new PageStateCache();
    cache.update('s1', [{ id: 'a', type: 'button', label: 'A' }], 'https://example.com');
    cache.clear('s1');
    const diff = cache.update('s1', [{ id: 'a', type: 'button', label: 'A' }], 'https://example.com');
    expect(diff.isNewPage).toBe(true);
  });
});
