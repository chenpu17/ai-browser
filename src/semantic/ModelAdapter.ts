import { SemanticElement, PageType, Intent } from '../types/index.js';

export interface ModelEnhancement {
  pageType?: PageType;
  intents?: Intent[];
  elementLabels?: Map<string, string>;
  summary?: string;
}

export interface SemanticModelAdapter {
  name: string;
  enhance(context: ModelContext): Promise<ModelEnhancement>;
}

export interface ModelContext {
  url: string;
  title: string;
  elements: SemanticElement[];
  text?: string;
}

export class ModelRegistry {
  private adapters: SemanticModelAdapter[] = [];

  register(adapter: SemanticModelAdapter): void {
    this.adapters.push(adapter);
  }

  unregister(name: string): void {
    this.adapters = this.adapters.filter((a) => a.name !== name);
  }

  async enhance(context: ModelContext): Promise<ModelEnhancement> {
    const result: ModelEnhancement = {
      intents: [],
      elementLabels: new Map(),
    };

    for (const adapter of this.adapters) {
      try {
        const enhancement = await adapter.enhance(context);
        this.mergeEnhancement(result, enhancement);
      } catch (err) {
        console.error(`Adapter ${adapter.name} failed:`, err);
      }
    }

    return result;
  }

  private mergeEnhancement(target: ModelEnhancement, source: ModelEnhancement): void {
    // pageType: 后者覆盖前者
    if (source.pageType !== undefined) {
      target.pageType = source.pageType;
    }
    // summary: 后者覆盖前者
    if (source.summary !== undefined) {
      target.summary = source.summary;
    }
    // intents: 合并数组
    if (source.intents) {
      target.intents = [...(target.intents || []), ...source.intents];
    }
    // elementLabels: 合并Map
    if (source.elementLabels) {
      source.elementLabels.forEach((v, k) => target.elementLabels!.set(k, v));
    }
  }

  getAdapters(): string[] {
    return this.adapters.map((a) => a.name);
  }
}
