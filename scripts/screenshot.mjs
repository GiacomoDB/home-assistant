#!/usr/bin/env node
// Screenshot dashboard views as a phone shows them, to check a deploy by eye.
//
//   node scripts/screenshot.mjs [out dir] [view ...]
//
// Views default to every `path:` in dashboards/home.yaml; the out dir to
// ./screenshots (gitignored). Needs, once:
//
//   npm install --no-save playwright-core@1.55.0
//
// It drives the installed Google Chrome, so there's no browser to download.
// The token is a long-lived token of a NON-admin HA user, read from
// ~/.config/home-assistant/screenshot-token (or HA_SCREENSHOT_TOKEN_FILE).
// HA_SCREENSHOT_URL overrides http://homeassistant.local:8123.

import { chromium } from 'playwright-core';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [outDir = 'screenshots', ...args] = process.argv.slice(2);
const views = args.length ? args : [...fs.readFileSync(path.join(repo, 'dashboards/home.yaml'), 'utf8')
  .matchAll(/^ {4}path: (\S+)$/gm)].map((m) => m[1]);
const dashboard = fs.readFileSync(path.join(repo, 'dashboards/dashboards.yaml'), 'utf8')
  .match(/url_path: (\S+)/)[1];
const token = fs.readFileSync(process.env.HA_SCREENSHOT_TOKEN_FILE
  || path.join(os.homedir(), '.config/home-assistant/screenshot-token'), 'utf8').trim();

// Headless Chrome can't resolve .local names, but Node can (the OS resolver
// speaks mDNS), so go by address.
const url = new URL(process.env.HA_SCREENSHOT_URL || 'http://homeassistant.local:8123');
if (url.hostname.endsWith('.local')) url.hostname = (await dns.lookup(url.hostname, { family: 4 })).address;
const base = url.origin;

const WIDTH = 412;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 915 }, deviceScaleFactor: 2, colorScheme: 'light' });
// The frontend keeps its login in localStorage. A long-lived token with a far
// expiry is never refreshed, so it works as is.
await ctx.addInitScript(([t, b]) => {
  localStorage.setItem('hassTokens', JSON.stringify({
    access_token: t, token_type: 'Bearer', expires_in: 1800, hassUrl: b,
    clientId: b + '/', expires: Date.now() + 365 * 864e5, refresh_token: '',
  }));
}, [token, base]);
const page = await ctx.newPage();

// A view scrolls inside shadow DOM, not the window, so find the tallest
// scrolling element and grow the viewport to fit it.
const contentHeight = () => page.evaluate(() => {
  let max = document.documentElement.scrollHeight;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 5 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)) {
        max = Math.max(max, el.scrollHeight + el.getBoundingClientRect().top);
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return Math.ceil(max);
});

fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const view of views) {
  await page.setViewportSize({ width: WIDTH, height: 915 });
  await page.goto(`${base}/${dashboard}/${view}`, { waitUntil: 'load' });
  await page.waitForTimeout(7000); // charts load their history after the page
  if (page.url().includes('/auth/')) {
    console.error(`${view}: sent to the login page, so the token is wrong or revoked`);
    failed++;
    continue;
  }
  await page.setViewportSize({ width: WIDTH, height: Math.min(await contentHeight(), 12000) });
  await page.waitForTimeout(3000);
  const file = path.join(outDir, `${view}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
process.exit(failed ? 1 : 0);
