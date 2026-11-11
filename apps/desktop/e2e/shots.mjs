// Screenshots of the main screens for design work: node e2e/shots.mjs <outDir> [light|dark]
import { build, serve, launch, device, onboard, pair, setName, newGroup, openChat, say, startRelay, relayNet, connected } from './lib.mjs';
const out = process.argv[2];
const theme = process.argv[3] ?? 'dark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = build();
const { server, url } = await serve(dist);
const browser = await launch();
const relay = await startRelay();
const net = relayNet(relay.url);
const shot = (p, name) => p.screenshot({ path: `${out}/${theme}-${name}.png` });
try {
  const a = await device(browser, url, net);
  await a.page.emulateMedia({ colorScheme: theme });
  await sleep(800);
  await shot(a.page, '0-onboarding');
  await onboard(a.page);
  await shot(a.page, '1-empty');
  const b = await device(browser, url, net);
  const c = await device(browser, url, net);
  await onboard(b.page);
  await onboard(c.page);
  await setName(a.page, 'Sree');
  await setName(b.page, 'Ann Lee');
  await setName(c.page, 'Ben Carter');
  await pair(a.page, b.page);
  await pair(a.page, c.page);
  await openChat(a.page, 'Ann Lee');
  await connected(a.page).catch(() => undefined);
  await say(a.page, 'Hey! Are we still on for dinner tonight?');
  await openChat(b.page, 0);
  await sleep(1500);
  await say(b.page, 'Yes! The river place sounds great');
  await say(b.page, 'Booking now. It is usually busy on Fridays so this might take a minute, but I will let you know as soon as it is confirmed.');
  await sleep(1500);
  await say(a.page, 'Perfect, see you at 7');
  await sleep(1500);
  await shot(a.page, '2-chat');
  await newGroup(a.page, 'Weekend trip', ['Ann Lee', 'Ben Carter']);
  await say(a.page, 'Who is driving on Saturday?');
  await sleep(2500);
  await shot(a.page, '3-group');
  await a.page.click('button[aria-label="Add friend"]');
  await sleep(800);
  await shot(a.page, '4-add');
  await a.page.keyboard.press('Escape');
  await a.page.click('button[aria-label="Settings"]');
  await sleep(600);
  await shot(a.page, '5-settings');
  if (process.argv.includes('--dialogs')) {
    const open = async (fn, name) => {
      await a.page.keyboard.press('Escape');
      await sleep(300);
      await fn();
      await sleep(700);
      await shot(a.page, name);
    };
    await open(() => a.page.click('button[aria-label="New group"]'), '6-newgroup');
    await open(() => a.page.click('button[aria-label="Channels"]'), '7-channels');
    await open(async () => {
      await openChat(a.page, 'Weekend trip');
      await a.page.click('button[aria-label="More"]');
      await a.page.click('[role="menuitem"]:has-text("Group details")');
    }, '8-groupdetails');
    await open(async () => {
      await openChat(a.page, 'Ann Lee');
      await a.page.click('button[aria-label="More"]');
      await a.page.click('[role="menuitem"]:has-text("Friend details")');
    }, '9-frienddetails');
    await open(async () => {
      await a.page.click('button[aria-label="More"]');
      await a.page.click('[role="menuitem"]:has-text("Connect without internet")');
    }, '10-manual');
    await open(async () => {
      await a.page.click('button[aria-label="Settings"]');
      await a.page.click('.tab:has-text("Security")');
      await a.page.click('button:has-text("Erase everything")');
    }, '11-wipe');
  }
} finally {
  await browser.close();
  server.close();
  relay.close();
}
