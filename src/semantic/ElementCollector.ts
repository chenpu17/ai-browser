import { Page, CDPSession } from 'puppeteer-core';
import { SemanticElement, ElementState, ActionType, Rect } from '../types/index.js';

interface CollectedNode {
  node: any;
  bounds: Rect;
  id: string;
}

const ATTRIBUTE_BATCH_SIZE = 50;

export class ElementCollector {
  private elementCounter = 0;

  async collect(page: Page): Promise<SemanticElement[]> {
    const client = await page.createCDPSession();
    try {
      // Enable DOM for node resolution
      await client.send('DOM.enable');
      const { nodes } = await client.send('Accessibility.getFullAXTree');
      const interactableNodes = nodes.filter((node: any) => this.isInteractable(node));
      const collectedNodes: CollectedNode[] = interactableNodes.map((node: any) => ({
        node,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        id: this.generateId(node),
      }));

      // Inject semantic IDs into DOM using page.evaluate
      await this.injectSemanticIds(client, collectedNodes);
      const boundsById = await this.collectBounds(page);
      for (const collected of collectedNodes) {
        collected.bounds = boundsById.get(collected.id) ?? { x: 0, y: 0, width: 0, height: 0 };
      }

      return collectedNodes.map((cn) => this.toSemanticElement(cn));
    } finally {
      await client.detach();
    }
  }

  private async injectSemanticIds(
    client: CDPSession,
    collectedNodes: CollectedNode[]
  ): Promise<void> {
    const backendNodeIds: number[] = [];
    const semanticIds: string[] = [];
    for (const { node, id } of collectedNodes) {
      if (node.backendDOMNodeId) {
        backendNodeIds.push(node.backendDOMNodeId);
        semanticIds.push(id);
      }
    }
    if (backendNodeIds.length === 0) return;

    try {
      const { nodeIds } = await client.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds });
      const pairs = nodeIds.map((nodeId: number, index: number) => ({ nodeId, semanticId: semanticIds[index] }));
      await this.mapInBatches(
        pairs,
        ATTRIBUTE_BATCH_SIZE,
        async ({ nodeId, semanticId }) => {
          if (!nodeId) return;
          await client.send('DOM.setAttributeValue', {
            nodeId,
            name: 'data-semantic-id',
            value: semanticId,
          });
        },
      );
    } catch {
      // Element may not be accessible
    }
  }

  private async mapInBatches<T, R>(
    items: T[],
    batchSize: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(mapper));
      results.push.apply(results, batchResults);
    }
    return results;
  }

  private async collectBounds(page: Page): Promise<Map<string, Rect>> {
    try {
      const bounds = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[data-semantic-id]'))
          .map((node) => {
            const el = node as HTMLElement;
            const id = el.getAttribute('data-semantic-id');
            if (!id) return null;
            const rect = el.getBoundingClientRect();
            return {
              id,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          })
          .filter(Boolean) as Array<{ id: string; rect: Rect }>;
      });
      return new Map(bounds.map((item) => [item.id, item.rect]));
    } catch {
      return new Map();
    }
  }

  private isInteractable(node: any): boolean {
    const role = node.role?.value;
    const interactableRoles = [
      'button', 'link', 'textbox', 'searchbox', 'checkbox',
      'radio', 'combobox', 'menuitem', 'tab'
    ];
    return interactableRoles.includes(role);
  }

  private toSemanticElement(cn: CollectedNode): SemanticElement {
    const { node, bounds, id } = cn;
    const role = node.role?.value || 'unknown';
    const name = node.name?.value || '';

    return {
      id,
      type: role,
      label: name,
      actions: this.getActions(role),
      state: this.getState(node),
      region: 'main',
      bounds,
    };
  }

  private generateId(node: any): string {
    const role = node.role?.value || 'unknown';
    const name = node.name?.value || '';
    const backendNodeId = node.backendDOMNodeId;
    const prefix = this.getRolePrefix(role);
    const label = name.slice(0, 20).replace(/\s+/g, '_') || 'unnamed';
    const suffix = backendNodeId ?? ++this.elementCounter;
    return `${prefix}_${label}_${suffix}`;
  }

  private getRolePrefix(role: string): string {
    const prefixMap: Record<string, string> = {
      button: 'btn',
      link: 'link',
      textbox: 'input',
      searchbox: 'input',
      checkbox: 'chk',
      radio: 'radio',
      combobox: 'select',
      menuitem: 'menu',
      tab: 'tab',
    };
    return prefixMap[role] || role;
  }

  private getActions(role: string): ActionType[] {
    const actionMap: Record<string, ActionType[]> = {
      button: ['click'],
      link: ['click'],
      textbox: ['type', 'clear', 'focus'],
      searchbox: ['type', 'clear', 'focus'],
      checkbox: ['click', 'check'],
      radio: ['click'],
      combobox: ['click', 'select'],
      menuitem: ['click'],
      tab: ['click'],
    };
    return actionMap[role] || ['click'];
  }

  private getState(node: any): ElementState {
    const disabledProp = node.properties?.find((p: any) => p.name === 'disabled');
    const focusedProp = node.properties?.find((p: any) => p.name === 'focused');
    const checkedProp = node.properties?.find((p: any) => p.name === 'checked');
    return {
      visible: true,
      enabled: disabledProp ? !disabledProp.value?.value : true,
      focused: focusedProp ? !!focusedProp.value?.value : false,
      checked: checkedProp ? !!checkedProp.value?.value : undefined,
      value: node.value?.value,
    };
  }
}
