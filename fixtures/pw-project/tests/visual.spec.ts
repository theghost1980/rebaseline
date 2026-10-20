import { expect, test } from '@playwright/test';

// UI_COLOR=changed switches the page to its "changed" look and makes the tests fail.
// (Playwright itself reads COLOR, so this must not be called that.)
const changed = process.env.UI_COLOR === 'changed';

function page(body: string): string {
  return `<html><body style="margin:0;padding:10px;background:#ffffff">${body}</body></html>`;
}

function box(id: string, color: string, width: number, height: number): string {
  return `<div id="${id}" style="width:${width}px;height:${height}px;background:${color}"></div>`;
}

test('changed screenshot', async ({ page: p }) => {
  await p.setContent(page(box('hero', changed ? '#e11d48' : '#2563eb', 80, 40)));
  await expect(p.locator('#hero')).toHaveScreenshot('hero.png');
});

test('unchanged screenshot', async ({ page: p }) => {
  await p.setContent(page(box('stable', '#16a34a', 40, 40)));
  await expect(p.locator('#stable')).toHaveScreenshot('stable.png');
});

test('auto named screenshot', async ({ page: p }) => {
  await p.setContent(page(box('card', changed ? '#9333ea' : '#f59e0b', 120, 60)));
  await expect(p).toHaveScreenshot();
});

test('two screenshots in one test', async ({ page: p }) => {
  // The first image is identical to hero.png on purpose: same hash, different name.
  // Both change, but the test stops at the first failure, so second.png is never compared.
  await p.setContent(page(box('first', changed ? '#facc15' : '#2563eb', 80, 40) + box('second', changed ? '#65a30d' : '#db2777', 50, 30)));
  await expect(p.locator('#first')).toHaveScreenshot('first.png');
  await expect(p.locator('#second')).toHaveScreenshot('second.png');
});

test('new screenshot', { tag: '@new' }, async ({ page: p }) => {
  await p.setContent(page(box('fresh', '#0f766e', 60, 60)));
  await expect(p.locator('#fresh')).toHaveScreenshot('brand-new.png');
});

test('not a screenshot failure', async ({ page: p }) => {
  await p.setContent(page('<h1>Welcome</h1>'));
  await expect(p.locator('h1')).toHaveText(changed ? 'Welcome back' : 'Welcome', { timeout: 500 });
});
