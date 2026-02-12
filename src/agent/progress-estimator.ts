/**
 * Heuristic progress estimator based on tool call patterns.
 * Maps tool usage sequences to approximate task completion phases.
 */

export interface ProgressInfo {
  phase: 'navigating' | 'observing' | 'acting' | 'extracting' | 'completing';
  percent: number;
  stepsRemaining: number | null;
}

const PHASE_MAP: Record<string, ProgressInfo['phase']> = {
  navigate: 'navigating',
  navigate_and_extract: 'navigating',
  get_page_info: 'observing',
  get_page_content: 'observing',
  find_element: 'observing',
  click: 'acting',
  click_and_wait: 'acting',
  type_text: 'acting',
  fill_form: 'acting',
  press_key: 'acting',
  scroll: 'acting',
  select_option: 'acting',
  hover: 'acting',
  set_value: 'acting',
  screenshot: 'observing',
  done: 'completing',
};

const PHASE_WEIGHT: Record<ProgressInfo['phase'], number> = {
  navigating: 15,
  observing: 30,
  acting: 55,
  extracting: 80,
  completing: 100,
};

export class ProgressEstimator {
  private history: string[] = [];
  private maxIterations: number;

  constructor(maxIterations = 20) {
    this.maxIterations = maxIterations;
  }

  record(toolName: string): ProgressInfo {
    this.history.push(toolName);
    return this.estimate();
  }

  estimate(): ProgressInfo {
    if (this.history.length === 0) {
      return { phase: 'navigating', percent: 0, stepsRemaining: null };
    }

    const last = this.history[this.history.length - 1];
    const phase = PHASE_MAP[last] || 'acting';

    // Check for extraction pattern: second get_page_content after acting
    const hasActed = this.history.some(t => PHASE_MAP[t] === 'acting');
    const contentCalls = this.history.filter(t => t === 'get_page_content' || t === 'navigate_and_extract').length;
    const isExtracting = hasActed && contentCalls >= 2;
    const effectivePhase = isExtracting && phase === 'observing' ? 'extracting' : phase;

    // Base percent from phase
    let percent = PHASE_WEIGHT[effectivePhase];

    // Adjust by iteration progress
    const iterationProgress = (this.history.length / this.maxIterations) * 100;
    percent = Math.max(percent, Math.min(iterationProgress, 95));
    percent = Math.min(percent, 99); // Never 100 until done

    if (last === 'done') {
      percent = 100;
    }

    // Rough steps remaining estimate
    const stepsRemaining = last === 'done'
      ? 0
      : Math.max(1, Math.round((100 - percent) / 15));

    return { phase: effectivePhase, percent: Math.round(percent), stepsRemaining };
  }
}
