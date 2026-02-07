import { Page } from 'puppeteer';

export function escapeCSS(str: string): string {
  return str.replace(/["\\]/g, '\\$&');
}

export function generateElementId(node: any): string {
  const role = node.role?.value || 'unknown';
  const name = node.name?.value || '';
  const prefixMap: Record<string, string> = {
    button: 'btn', link: 'link', textbox: 'input',
    checkbox: 'chk', radio: 'radio', combobox: 'select',
    menuitem: 'menu', tab: 'tab',
  };
  const prefix = prefixMap[role] || role;
  const label = name.slice(0, 20).replace(/\s+/g, '_') || 'unnamed';
  const suffix = node.backendDOMNodeId ?? 0;
  return `${prefix}_${label}_${suffix}`;
}

export async function clickByAccessibility(page: Page, elementId: string): Promise<void> {
  const client = await page.createCDPSession();
  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    const node = nodes.find((n: any) => generateElementId(n) === elementId);
    if (!node?.backendDOMNodeId) throw new Error('Element not found');
    const { object } = await client.send('DOM.resolveNode', {
      backendNodeId: node.backendDOMNodeId,
    });
    if (!object?.objectId) throw new Error('Cannot resolve element');
    try {
      await client.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { this.scrollIntoView({block:"center"}); this.click(); }',
      });
    } finally {
      await client.send('Runtime.releaseObject', {
        objectId: object.objectId,
      }).catch(() => {});
    }
  } finally {
    try { await client.detach(); } catch {}
  }
}

export async function typeByAccessibility(page: Page, elementId: string, value: string): Promise<void> {
  const client = await page.createCDPSession();
  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    const node = nodes.find((n: any) => generateElementId(n) === elementId);
    if (!node?.backendDOMNodeId) throw new Error('Element not found');
    await client.send('DOM.focus', { backendNodeId: node.backendDOMNodeId });
    await page.keyboard.type(value);
  } finally {
    try { await client.detach(); } catch {}
  }
}

export async function executeAction(
  page: Page,
  action: string,
  elementId?: string,
  value?: string
): Promise<void> {
  switch (action) {
    case 'click':
      if (!elementId) throw new Error('elementId required for click');
      const selector = `[data-semantic-id="${escapeCSS(elementId)}"]`;
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.removeAttribute('target');
      }, selector);
      try {
        await page.click(selector);
      } catch {
        await clickByAccessibility(page, elementId);
      }
      await new Promise(r => setTimeout(r, 500));
      break;

    case 'type':
      if (!elementId) throw new Error('elementId required for type');
      if (value === undefined) throw new Error('value required for type');
      try {
        await page.type(`[data-semantic-id="${escapeCSS(elementId)}"]`, value);
      } catch {
        await typeByAccessibility(page, elementId, value);
      }
      break;

    case 'scroll':
      const direction = value === 'up' ? -300 : 300;
      await page.evaluate((d) => window.scrollBy(0, d), direction);
      break;

    case 'back':
      await page.goBack();
      break;

    case 'forward':
      await page.goForward();
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
