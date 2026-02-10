import { Page, CDPSession } from 'puppeteer-core';
import { SemanticElement, ElementState, ActionType, Rect } from '../types/index.js';

interface CollectedNode {
  node: any;
  bounds: Rect;
  id: string;
}

export class ElementCollector {
  private elementCounter = 0;

  async collect(page: Page): Promise<SemanticElement[]> {
    const client = await page.createCDPSession();
    try {
      // Enable DOM for node resolution
      await client.send('DOM.enable');
      const { nodes } = await client.send('Accessibility.getFullAXTree');
      const collectedNodes: CollectedNode[] = [];

      for (const node of nodes) {
        if (this.isInteractable(node)) {
          const bounds = await this.getBounds(client, node.backendDOMNodeId);
          const id = this.generateId(node);
          collectedNodes.push({ node, bounds, id });
        }
      }

      // Inject semantic IDs into DOM using page.evaluate
      await this.injectSemanticIds(page, client, collectedNodes);

      return collectedNodes.map((cn) => this.toSemanticElement(cn));
    } finally {
      await client.detach();
    }
  }

  private async injectSemanticIds(
    page: Page,
    client: CDPSession,
    collectedNodes: CollectedNode[]
  ): Promise<void> {
    // Build a map of backendNodeId -> semanticId
    const nodeIdMap: Array<{ backendNodeId: number; semanticId: string }> = [];
    for (const { node, id } of collectedNodes) {
      if (node.backendDOMNodeId) {
        nodeIdMap.push({ backendNodeId: node.backendDOMNodeId, semanticId: id });
      }
    }

    // Resolve backend node IDs to object IDs and inject attributes
    for (const { backendNodeId, semanticId } of nodeIdMap) {
      try {
        const { object } = await client.send('DOM.resolveNode', { backendNodeId });
        if (object?.objectId) {
          try {
            await client.send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: `function(id) { this.setAttribute('data-semantic-id', id); }`,
              arguments: [{ value: semanticId }],
            });
          } finally {
            await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
          }
        }
      } catch {
        // Element may not be accessible
      }
    }
  }

  private async getBounds(client: CDPSession, backendNodeId?: number): Promise<Rect> {
    if (!backendNodeId) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    try {
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId });
      if (model?.content) {
        const [x1, y1, x2, , , y3] = model.content;
        return { x: x1, y: y1, width: x2 - x1, height: y3 - y1 };
      }
    } catch {
      // Element may not have a box model (e.g., hidden)
    }
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  private isInteractable(node: any): boolean {
    const role = node.role?.value;
    const interactableRoles = [
      'button', 'link', 'textbox', 'checkbox',
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
