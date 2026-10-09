// End-to-end smoke test on a phone-sized viewport. Usage: node e2e/smoke.mjs <outdir>
import { chromium, devices } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';

const OUT = process.argv[2] ?? 'test-results';
mkdirSync(OUT, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:4173/';
const errors = [];
const step = async (name, fn) => { process.stdout.write(`• ${name} … `); await fn(); console.log('ok'); };

const b = await chromium.launch({ executablePath: process.env.CHROME });
const ctx = await b.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

await step('home loads', async () => {
  await page.goto(APP);
  await page.getByRole('button', { name: 'New project' }).waitFor();
  await shot('01-home');
});

await step('create novel project', async () => {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Title').fill('The Harbour');
  await page.getByRole('radio', { name: /Novel/ }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('tree').waitFor();
  await shot('02-binder');
});

await step('open scene and type', async () => {
  await page.getByRole('treeitem', { name: /Scene 1/ }).getByRole('button', { name: 'Scene 1', exact: true }).click();
  const ed = page.locator('.ProseMirror').first();
  await ed.click();
  await page.keyboard.type('The fog came in off the water like a held breath. Nobody moved.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('He said it was late, and left.');
  await page.getByText('20 words').waitFor();
  await shot('03-editor');
});

await step('bold + comment + footnote', async () => {
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 13; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByRole('dialog').locator('textarea').fill('Is this too slow?');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('.cm-anchor').first().waitFor();
  // footnote on the word under the cursor
  await page.locator('.ProseMirror').first().getByText('late').click();
  await page.getByRole('button', { name: 'Add footnote' }).click();
  await page.getByRole('dialog').locator('textarea').fill('Source: harbour logs.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('.fn-anchor').first().waitFor();
  await shot('04-comment');
});

await step('survives reload (no lost work)', async () => {
  await page.waitForTimeout(600);
  await page.reload();
  await page.locator('.ProseMirror').first().getByText('held breath').waitFor();
  const html = await page.locator('.ProseMirror').first().innerHTML();
  if (!html.includes('<strong>')) throw new Error('bold lost');
  if (!html.includes('cm-anchor') || !html.includes('fn-anchor')) throw new Error('comment/footnote lost');
});

await step('inspector: synopsis, snapshot', async () => {
  await page.getByRole('button', { name: 'Inspector' }).click();
  await page.getByRole('tab', { name: 'Synopsis' }).click();
  await page.getByRole('dialog').locator('textarea.synopsis').fill('Arrival in fog.');
  await page.getByRole('tab', { name: 'Snapshots' }).click();
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await page.getByRole('dialog', { name: 'Take snapshot' }).locator('input').fill('First pass');
  await page.getByRole('dialog', { name: 'Take snapshot' }).getByRole('button', { name: 'Take snapshot' }).click();
  await page.getByText('First pass').waitFor();
  await shot('05-snapshots');
  await page.getByRole('tab', { name: 'Comments' }).click();
  await page.getByText('Is this too slow?').waitFor();
  await page.getByText('Source: harbour logs.').waitFor();
  await shot('06-comments');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
});

await step('split document at cursor', async () => {
  await shot('05b-after-inspector');
  await page.locator('.ProseMirror p').nth(1).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'More', exact: true }).last().click();
  await page.getByRole('menuitem', { name: 'Split document at cursor' }).click();
  await page.getByRole('dialog').locator('input').fill('Scene 2');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await page.locator('h1.doc-title', { hasText: 'Scene 2' }).waitFor();
  await page.locator('.ProseMirror').first().getByText('He said it was late').waitFor();
  await page.waitForTimeout(200);
  const t = await page.locator('.ProseMirror').first().innerText();
  if (t.includes('held breath')) throw new Error('split did not move text');
});

await step('corkboard + outliner of chapter', async () => {
  await page.getByRole('button', { name: 'Show binder' }).click();
  await page.locator('.binder-main', { hasText: 'Chapter 1' }).click();
  await page.getByRole('tab', { name: 'Corkboard' }).click();
  await page.locator('.card').first().waitFor();
  const n = await page.locator('article.card').count();
  if (n !== 2) throw new Error('expected 2 cards, got ' + n);
  await page.getByText('Arrival in fog.').waitFor();
  await shot('07-corkboard');
  await page.getByRole('tab', { name: 'Outliner' }).click();
  await page.locator('table.outliner').waitFor();
  await shot('08-outliner');
  await page.getByRole('tab', { name: /Scrivenings/ }).click();
  await page.locator('.scriv-section').nth(1).locator('.ProseMirror').waitFor();
  await shot('09-scrivenings');
});

await step('project search', async () => {
  await page.getByRole('button', { name: 'Show binder' }).click();
  await page.getByRole('button', { name: 'Search project' }).click();
  await page.getByLabel('Find').fill('fog');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('.hits li').first().waitFor();
  await shot('10-search');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
});

await step('compile to docx, md, epub', async () => {
  await page.getByRole('treeitem', { name: /Scene 2/ }).getByRole('button', { name: 'Scene 2', exact: true }).click();
  for (const [fmt, ext] of [['docx', 'docx'], ['md', 'md'], ['epub', 'epub']]) {
    await page.getByRole('button', { name: 'More', exact: true }).first().click();
    await page.getByRole('menuitem', { name: /Compile/ }).click();
    await page.getByRole('dialog').locator('select').first().selectOption(fmt);
    if (fmt === 'docx') await shot('11-compile');
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Compile', exact: true }).click();
    const d = await dl;
    await d.saveAs(`${OUT}/out.${ext}`);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  const md = readFileSync(`${OUT}/out.md`, 'utf8');
  if (!md.includes('**Nobody moved.**') || !md.includes('[^1]: Source: harbour logs.')) throw new Error('markdown wrong:\n' + md);
  if (md.includes('Is this too slow')) throw new Error('comment leaked into compile');
});

await step('import .scriv zip', async () => {
  const fx = (f) => readFileSync(new URL(`../tests/fixtures/${f}`, import.meta.url));
  const scrivx = readFileSync(new URL('../tests/fixtures/sample.ts', import.meta.url), 'utf8').match(/SCRIVX = `([\s\S]*?)`;/)[1];
  const zip = zipSync({
    'Novel.scriv/Novel.scrivx': strToU8(scrivx),
    'Novel.scriv/Files/Data/CCCCCCCC-0000-4000-8000-000000000001/content.rtf': new Uint8Array(fx('docks.rtf')),
    'Novel.scriv/Files/Data/CCCCCCCC-0000-4000-8000-000000000001/synopsis.txt': strToU8('Arrival at the docks.'),
  });
  writeFileSync(`${OUT}/Novel.scriv.zip`, zip);
  await page.getByRole('button', { name: 'Show binder' }).click();
  await page.getByRole('button', { name: 'All projects' }).click();
  await page.locator('input[type=file][accept*=zip]').setInputFiles(`${OUT}/Novel.scriv.zip`);
  await page.locator('.binder-row', { hasText: 'Chapter One' }).getByRole('button', { name: 'Expand' }).click();
  await page.locator('.binder-main', { hasText: 'The Docks' }).click();
  await page.locator('.ProseMirror').first().getByText('Café lights').waitFor();
  await shot('12-imported');
});

await step('desktop layout', async () => {
  const dp = await ctx.newPage();
  await dp.setViewportSize({ width: 1280, height: 800 });
  dp.on('pageerror', (e) => errors.push('pageerror(desktop): ' + e.message));
  await dp.goto(APP);
  await dp.locator('.pc-main', { hasText: 'The Harbour' }).click();
  await dp.getByRole('tree').waitFor();
  await dp.getByRole('button', { name: 'Inspector' }).click();
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: `${OUT}/13-desktop.png` });
  await dp.close();
});

await b.close();
if (errors.length) { console.log('\nBrowser errors:\n' + errors.join('\n')); process.exit(1); }
console.log('\nAll e2e steps passed.');
