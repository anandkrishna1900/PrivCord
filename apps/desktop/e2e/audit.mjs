// UI audit: node e2e/audit.mjs [outDir]
// Builds three devices with long names and messages, opens every main screen and dialog at several window sizes in
// light and dark, and reports clipped text, things outside the window, horizontal scrolling, small click targets and
// low-contrast text. Exits 1 if anything is found.
import { build, serve, launch, device, onboard, pair, setName, newGroup, openChat, say, startRelay, relayNet, connected } from './lib.mjs';
const out = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs in the page: what looks broken right now. */
function auditPage() {
  const problems = [];
  const vw = window.innerWidth;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''} "${t}"`;
  };
  // Inside a modal, only the modal counts (the page behind it is dimmed on purpose).
  const root = document.querySelector('.modal') ?? document.body;
  if (document.documentElement.scrollWidth > vw + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    // Blend backgrounds from the element up to the root.
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
      if (getComputedStyle(e).backgroundImage !== 'none') return null; // an image or gradient: not measurable
    }
    let base = { r: 255, g: 255, b: 255 };
    for (const c of layers.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) };
    return base;
  };
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (el.closest('.modal-backdrop') && !el.closest('.modal') && root !== document.body) continue;
    // Off the right or left edge of the window.
    if (r.right > vw + 1 || r.left < -1) {
      if (!el.closest('[style*="overflow"]') && s.position !== 'fixed') problems.push(`outside the window: ${label(el)} (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
    }
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    // Text cut off with no ellipsis.
    if (ownText && el.scrollWidth > el.clientWidth + 2 && s.overflowX !== 'visible' && s.textOverflow !== 'ellipsis' && !['INPUT', 'TEXTAREA'].includes(el.tagName))
      problems.push(`text cut off: ${label(el)}`);
    // Small click targets.
    if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && (r.height < 28 || r.width < 28) && !el.closest('.bubble-meta'))
      problems.push(`small target ${Math.round(r.width)}x${Math.round(r.height)}: ${label(el)}`);
    // Contrast of text.
    if (ownText && !el.closest('.qr')) {
      const fg = parse(s.color);
      const bg = bgOf(el);
      if (fg && bg) {
        const blended = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
        const [a, b] = [lum(blended), lum(bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        const large = parseFloat(s.fontSize) >= 18.66 || (parseFloat(s.fontSize) >= 14 && Number(s.fontWeight) >= 700);
        const disabled = el.closest('button:disabled, [aria-disabled="true"]');
        if (!disabled && ratio < (large ? 3 : 4.5)) problems.push(`contrast ${ratio.toFixed(2)}: ${label(el)}`);
      }
    }
  }
  return [...new Set(problems)];
}

const dist = build();
const { server, url } = await serve(dist);
const browser = await launch();
const relay = await startRelay();
const net = relayNet(relay.url);
const report = [];
try {
  const a = await device(browser, url, net);
  const b = await device(browser, url, net);
  const c = await device(browser, url, net);
  for (const d of [a, b, c]) await onboard(d.page);
  await setName(a.page, 'Sree');
  await setName(b.page, 'Annabelle Montgomery-Fitzgerald the Third');
  await setName(c.page, 'Ben');
  await pair(a.page, b.page);
  await pair(a.page, c.page);
  await openChat(a.page, 'Annabelle');
  await connected(a.page).catch(() => undefined);
  await say(a.page, 'Hey!');
  await openChat(b.page, 0);
  await sleep(1000);
  await say(b.page, 'A_very_long_word_without_any_spaces_that_could_overflow_the_bubble_https://example.org/a/really/long/path/that/keeps/going');
  await say(b.page, 'Booking now. It is usually busy on Fridays so this might take a minute, but I will let you know as soon as it is confirmed.');
  await sleep(1500);
  await newGroup(a.page, 'A group with a rather long name for testing', ['Annabelle', 'Ben']);
  await say(a.page, 'Who is driving on Saturday?');
  await sleep(1500);

  const p = a.page;
  // A screen that cannot be opened at some size is reported, not waited on for 30 s.
  p.setDefaultTimeout(4000);
  const screens = [
    ['chat', async () => openChat(p, 'Annabelle')],
    ['group', async () => openChat(p, 'A group')],
    ['add', async () => p.click('button[aria-label="Add friend"]')],
    ['newgroup', async () => p.click('button[aria-label="New group"]')],
    ['channels', async () => p.click('button[aria-label="Channels"]')],
    ['settings', async () => p.click('button[aria-label="Settings"]')],
    ['settings-look', async () => { await p.click('button[aria-label="Settings"]'); await p.click('.tab:has-text("Look")'); }],
    ['settings-connection', async () => { await p.click('button[aria-label="Settings"]'); await p.click('.tab:has-text("Connection")'); }],
    ['settings-security', async () => { await p.click('button[aria-label="Settings"]'); await p.click('.tab:has-text("Security")'); }],
    ['settings-about', async () => { await p.click('button[aria-label="Settings"]'); await p.click('.tab:has-text("About")'); }],
    ['groupdetails', async () => { await openChat(p, 'A group'); await p.click('button[aria-label="More"]'); await p.click('[role="menuitem"]:has-text("Group details")'); }],
    ['frienddetails', async () => { await openChat(p, 'Annabelle'); await p.click('button[aria-label="More"]'); await p.click('[role="menuitem"]:has-text("Friend details")'); }],
    ['menu', async () => { await openChat(p, 'Annabelle'); await p.click('button[aria-label="More"]'); }],
  ];
  for (const [w, h] of [[1280, 800], [900, 640], [880, 600], [420, 780]]) {
    for (const scheme of ['light', 'dark']) {
      await p.setViewportSize({ width: w, height: h });
      await p.emulateMedia({ colorScheme: scheme });
      for (const [name, open] of screens) {
        for (let i = 0; i < 3; i += 1) await p.keyboard.press('Escape');
        await p.mouse.click(2, h - 2).catch(() => undefined);
        await sleep(150);
        if (w < 700 && !name.startsWith('chat') && !name.startsWith('group') && (await p.locator('.back-button').isVisible().catch(() => false))) await p.click('.back-button');
        try {
          await open();
        } catch (e) {
          report.push(`${w}x${h} ${scheme} ${name}: could not open (${e.message.split('\n')[0]})`);
          continue;
        }
        await sleep(450);
        const found = await p.evaluate(auditPage);
        for (const f of found) report.push(`${w}x${h} ${scheme} ${name}: ${f}`);
        if (out && found.length) await p.screenshot({ path: `${out}/audit-${w}-${scheme}-${name}.png` });
      }
    }
  }
} finally {
  await browser.close();
  server.close();
  relay.close();
}
console.log(report.length ? report.join('\n') : 'No problems found.');
process.exit(report.length ? 1 : 0);
