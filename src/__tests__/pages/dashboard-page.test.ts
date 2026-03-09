import { describe, expect, test } from 'bun:test';

describe('Dashboard page source', () => {
  test('exists and imports ProductList with local auth context usage', async () => {
    const dashboardPath = new URL('../../pages/Dashboard.tsx', import.meta.url);
    const dashboardFile = Bun.file(dashboardPath);

    expect(await dashboardFile.exists()).toBe(true);

    const source = await dashboardFile.text();

    expect(source).toContain('import ProductList');
    expect(source).toContain('createContext');
    expect(source).toContain('useContext');
  });
});
