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

    case 'hover':
      if (!elementId) throw new Error('elementId required for hover');
      const hoverSelector = `[data-semantic-id="${escapeCSS(elementId)}"]`;
      try {
        await page.hover(hoverSelector);
      } catch {
        // Fallback: use accessibility tree to find and hover
        const client = await page.createCDPSession();
        try {
          const { nodes } = await client.send('Accessibility.getFullAXTree');
          const node = nodes.find((n: any) => generateElementId(n) === elementId);
          if (!node?.backendDOMNodeId) throw new Error('Element not found');
          const { object } = await client.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
          if (!object?.objectId) throw new Error('Cannot resolve element');
          try {
            await client.send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: 'function() { this.scrollIntoView({block:"center"}); this.dispatchEvent(new MouseEvent("mouseover", {bubbles:true})); this.dispatchEvent(new MouseEvent("mouseenter", {bubbles:false})); }',
            });
          } finally {
            await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
          }
        } finally {
          try { await client.detach(); } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 300));
      break;

    case 'select':
      if (!elementId) throw new Error('elementId required for select');
      if (value === undefined) throw new Error('value required for select');
      const selectSelector = `[data-semantic-id="${escapeCSS(elementId)}"]`;
      try {
        await page.select(selectSelector, value);
      } catch {
        // Fallback: use accessibility tree to find and select
        const client = await page.createCDPSession();
        try {
          const { nodes } = await client.send('Accessibility.getFullAXTree');
          const node = nodes.find((n: any) => generateElementId(n) === elementId);
          if (!node?.backendDOMNodeId) throw new Error('Element not found');
          const { object } = await client.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
          if (!object?.objectId) throw new Error('Cannot resolve element');
          try {
            await client.send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: `function(v) { this.value = v; this.dispatchEvent(new Event('change', {bubbles:true})); }`,
              arguments: [{ value }],
            });
          } finally {
            await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
          }
        } finally {
          try { await client.detach(); } catch {}
        }
      }
      break;

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

export async function setValueByAccessibility(
  page: Page,
  elementId: string,
  value: string,
  isHtml: boolean = false,
): Promise<void> {
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
        functionDeclaration: `function(value, isHtml) {
          var tag = this.tagName ? this.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea') {
            this.focus();
            this.value = value;
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
          } else if (this.isContentEditable || this.contentEditable === 'true') {
            this.focus();
            if (isHtml) {
              this.innerHTML = value;
            } else {
              this.innerText = value;
            }
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
          } else {
            throw new Error('Element is not an input, textarea, or contenteditable');
          }
        }`,
        arguments: [{ value }, { value: isHtml }],
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
