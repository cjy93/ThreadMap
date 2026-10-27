import { expect, test, type Page } from '@playwright/test';

// Runs against a started ThreadMap (E2E_BASE_URL), using the isolated demo.
async function openDemo(page: Page) {
  await page.goto('/demo');
  try {
    await page.waitForURL('**/app', { timeout: 60_000 });
  } catch (e) {
    throw new Error(`demo did not open: ${await page.locator('main').innerText().catch(() => '?')}`, { cause: e });
  }
  await expect(page.getByRole('button', { name: /Builders and Hackathons/ })).toBeVisible();
  await page.getByRole('button', { name: /Builders and Hackathons/ }).click();
  await expect(page.locator('.cnode').first()).toBeVisible();
}

// The camera is preserved across depth/filter changes; fit explicitly before clicking.
async function fit(page: Page) {
  await page.getByRole('button', { name: /fit view/i }).click();
  await page.waitForTimeout(300);
}

const nodeBody = (page: Page, title: string) => page.locator('.cnode', { has: page.locator('.label', { hasText: new RegExp(`^${title}$`) }) }).locator('.body');

test('map sizes and deep access from an ancestor', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Chat: 120 messages');
  // There is no depth control any more: every level loads and branches open from the map.
  await expect(page.getByLabel('Show depth')).toHaveCount(0);
  await expect(nodeBody(page, 'Knowledge')).toBeVisible();
  // Open Programming (depth 1) and reach the six-level-deep file without expanding.
  await fit(page);
  await nodeBody(page, 'Programming').dispatchEvent('click');
  await page.getByRole('tab', { name: 'Files' }).click();
  const file = page.locator('.msg', { hasText: 'refresh-flow-diagram.pdf' });
  await expect(file).toBeVisible();
  await expect(file).toContainText('Knowledge › Programming › Hackathons › Solutions › Authentication › Tokens › Refresh flow');
  await file.getByRole('button', { name: 'Open source message' }).click();
  await expect(page.getByRole('article', { name: 'Selected source message' })).toContainText('sequence diagram');
  await expect(page.getByRole('link', { name: 'Open' })).toBeVisible();
  // Opening the parent list did not mark anything Read; the focused source does after 2 s.
  await expect(page.getByRole('article')).toContainText('Missed');
  await page.waitForTimeout(2600);
  await expect(page.getByRole('article')).toContainText('Read', { timeout: 5000 });
  await page.getByRole('button', { name: 'Mark Missed' }).click();
  await expect(page.getByRole('article').locator('strong.missed')).toHaveText('Missed');
  await page.waitForTimeout(2600);
  await expect(page.getByRole('article').locator('strong.missed')).toHaveText('Missed'); // no auto-reversal
});

test('outline parity, keyboard access and an unobstructed map', async ({ page }) => {
  await openDemo(page);
  await expect(page.getByLabel('Size legend')).toHaveCount(0);
  await page.getByRole('button', { name: 'Outline' }).click();
  const rows = page.getByRole('treeitem');
  await expect(rows.first()).toBeVisible();
  const heights = await rows.evaluateAll((els) => els.slice(0, 10).map((e) => (e as HTMLElement).offsetHeight));
  expect(new Set(heights).size).toBe(1);
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('matching messages');
});

test('combined filters and cross-chat related evidence', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: /Programming Study Group/ }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await fit(page);
  await nodeBody(page, 'Tokens').dispatchEvent('click');
  await page.getByRole('tab', { name: 'Related chats' }).click();
  await expect(page.locator('.msg').first()).toContainText('Builders and Hackathons');
  await expect(page.locator('.msg').first()).toContainText('Evidence here');
  await page.getByRole('button', { name: 'Filter to this topic' }).click();
  await expect(page.locator('.pill', { hasText: 'Topic:' })).toBeVisible();
  await page.getByRole('button', { name: 'Missed', exact: true }).click();
  // Ancestor count equals the selected subtree's matching count once the new filter's response lands.
  await expect
    .poll(async () => [await nodeBody(page, 'Knowledge').textContent(), await nodeBody(page, 'Tokens').textContent()])
    .toEqual([expect.any(String), expect.any(String)]);
  await expect.poll(async () => (await nodeBody(page, 'Knowledge').textContent()) === (await nodeBody(page, 'Tokens').textContent())).toBe(true);
});

test('reduced motion disables transitions', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await openDemo(page);
  const t = await page.locator('.react-flow__node').first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(t).toBe('0s');
  await ctx.close();
});

test('live review change updates counts while preserving the open drawer and camera', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await fit(page);
  await nodeBody(page, 'Knowledge').dispatchEvent('click');
  const drawer = page.getByRole('complementary', { name: 'Details' });
  await expect(drawer).toContainText('44 matching messages');
  const vp = await page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
  // Another tab of the same user marks a Knowledge message Read via the API.
  const first = await page.evaluate(async () => {
    const chats = await (await fetch('/api/chats')).json();
    const chat = chats.chats.find((c: { title: string }) => c.title === 'Builders and Hackathons');
    const map = await (await fetch(`/api/chats/${chat.id}/map?status=all`)).json();
    const k = map.nodes.find((n: { title: string }) => n.title === 'Knowledge');
    const content = await (await fetch(`/api/chats/${chat.id}/nodes/${k.id}/content?status=all`)).json();
    const m = content.items[0];
    await fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message_id: m.message_id, status: 'read', revision: m.content_revision }) });
    return m.message_id;
  });
  expect(first).toBeTruthy();
  await expect(drawer).toContainText('43 missed', { timeout: 15_000 }); // SSE → refetch
  await expect(drawer).toContainText('44 matching messages'); // size unchanged under All
  const vp2 = await page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
  expect(vp2).toBe(vp);
});
