import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CancelToken } from '../src/task/cancel-token.js';
import { executeLoginKeepSession } from '../src/task/templates/login-keep-session.js';

const mockActions = vi.hoisted(() => ({
  navigate: vi.fn(),
  waitForStable: vi.fn(),
  getPageInfo: vi.fn(),
  findElement: vi.fn(),
  typeText: vi.fn(),
  click: vi.fn(),
  pressKey: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('../src/task/tool-actions.js', () => mockActions);

function makeContext() {
  const page = {
    $eval: vi.fn(async (selector: string) => {
      if (selector === '#username') return 'input_username_1';
      if (selector === '#password') return 'input_password_2';
      if (selector === '#submit') return 'btn_submit_3';
      throw new Error(`No element: ${selector}`);
    }),
    url: vi.fn(() => 'https://example.com/login'),
    title: vi.fn(async () => 'Login Page'),
  } as any;

  const tab = { id: 'tab-1', page } as any;

  const ctx = {
    sessionManager: {} as any,
    cookieStore: undefined,
    urlOpts: {},
    trustLevel: 'local' as const,
    resolveSession: async (sessionId?: string) => sessionId ?? 'sess-default',
    getActiveTab: vi.fn(() => tab),
    getTab: vi.fn(() => tab),
    injectCookies: vi.fn(async () => {}),
    saveCookies: vi.fn(async () => {}),
  } as any;

  return { ctx, tab };
}

describe('login_keep_session (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockActions.navigate.mockResolvedValue({ success: true });
    mockActions.waitForStable.mockResolvedValue({ stable: true });
    mockActions.getPageInfo.mockResolvedValue({});
    mockActions.typeText.mockResolvedValue({ success: true });
    mockActions.click.mockResolvedValue({ success: true });
    mockActions.pressKey.mockResolvedValue({ success: true });
    mockActions.findElement.mockResolvedValue({ candidates: [] });
  });

  it('returns success=false when success indicator times out', async () => {
    const { ctx } = makeContext();
    const timeoutErr = new Error('timeout waiting for selector');
    (timeoutErr as any).name = 'TimeoutError';
    mockActions.wait.mockRejectedValueOnce(timeoutErr);

    const result = await executeLoginKeepSession(
      ctx,
      'sess-1',
      {
        startUrl: 'https://example.com/login',
        credentials: { username: 'alice', password: 'secret' },
        fields: {
          mode: 'selector',
          usernameSelector: '#username',
          passwordSelector: '#password',
        },
        successIndicator: { type: 'selector', value: '#dashboard' },
      },
      new CancelToken(),
    );

    expect(result.success).toBe(false);
    expect(result.loginState).toBe('unknown');
    expect(result.error).toContain('Success indicator');
    expect(result.sessionId).toBe('sess-1');
    expect(mockActions.wait).toHaveBeenCalledWith(
      ctx,
      'sess-1',
      'tab-1',
      expect.objectContaining({ condition: 'selector', selector: '#dashboard' }),
    );
  });
});
