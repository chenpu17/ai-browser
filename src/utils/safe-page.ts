/**
 * Safe page helpers — guards against "Execution context was destroyed" errors
 * that occur when page.title() is called during/after navigation.
 */

/** Returns page title, or '' if execution context was destroyed */
export async function safePageTitle(page: { title(): Promise<string> }): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '';
  }
}
