import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { E2E_INIT_SCRIPT } from '../helpers/reset';

// Explicit, isolated screenshot generator. Never connects to a user workspace.
test('build and capture the Play Store demo workspace', async ({ browser }) => {
  test.skip(process.env.CARBON_CAPTURE_DEMO !== '1', 'Explicit demo generation only');
  test.setTimeout(240_000);
  const output = resolve('output/play-store/demo');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await context.addInitScript(E2E_INIT_SCRIPT);
  await context.addInitScript(() => {
    localStorage.setItem('carbon.themeMode', 'dark');
    localStorage.setItem('carbon.darkTheme', 'dark');
  });
  const page = await context.newPage();
  await page.route('**/api/health', route => route.fulfill({ json: { role: 'single', status: 'ok' } }));
  await page.goto('/local');
  await page.waitForFunction(() => (window as any).__carbonE2e?.ready);
  const assets = Object.fromEntries(['coastal-weekend', 'lemon-orzo'].map(name =>
    [name, readFileSync(`${output}/assets/${name}.jpg`).toString('base64')]));
  const ids = await page.evaluate(async ({ corePath, assets }) => {
    const [{ getDb, getDeviceId, flushPersist }, { useStore }, core, { storeFile }, { ensureNoteThumb }] = await Promise.all([
      import('/src/lib/db.ts'), import('/src/lib/store.ts'), import(corePath),
      import('/src/lib/blobs.ts'), import('/src/lib/thumbs.ts'),
    ]);
    const db = getDb(), device = getDeviceId();
    const { createItem, updateItem, createTag, setItemTags, addToPlan, recordRecordOp } = core;
    const tags: Record<string, string> = {};
    for (const [name, color] of Object.entries({ Creative: '#a78bfa', Home: '#86b990', Errands: '#e9b96e', Outdoors: '#6bbdd3', Focus: '#d89cc8' }))
      tags[name] = createTag(db, device, name, color).id;
    const date = (offset = 0, hour = 17) => {
      const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(hour, 0, 0, 0); return d.toISOString();
    };
    const project = (title: string, color: string, sortOrder: number, notesProject = false) =>
      createItem(db, device, { title, type: 'project', color, sortOrder, notesProject });
    const garden = project('Balcony garden', '#86b990', 0);
    const studio = project('Studio website', '#a78bfa', 1);
    const trip = project('Coastal weekend', '#6bbdd3', 2);
    const home = project('Everyday life', '#e9b96e', 3);
    const notebook = project('Notes & inspiration', '#d89cc8', 4, true);
    const recipes = project('Recipe collection', '#e8997b', 5, true);
    for (const p of [garden, studio, trip, home]) updateItem(db, device, p.id, { review_interval: 7, reviewed_at: date(-8) });
    const task = (title: string, parentId: string | null, options: any = {}) => {
      const { tag, estimate, plan, done, ...input } = options;
      const item = createItem(db, device, { title, parentId, ...input });
      if (tag) setItemTags(db, device, item.id, [tags[tag]]);
      if (estimate) updateItem(db, device, item.id, { estimate_minutes: estimate });
      if (plan) addToPlan(db, device, null, item.id);
      if (done) updateItem(db, device, item.id, { status: 'done', completed_at: date(-1) });
      return item;
    };
    task('Measure the sunny corner', garden.id, { tag: 'Home', done: true, estimate: 15 });
    const pots = task('Choose pots for the balcony', garden.id, { tag: 'Home', flagged: true, dueDate: date(), estimate: 20, plan: true, note: 'Terracotta pots, good drainage and enough room for the herbs to grow. Keep the walkway clear.' });
    task('Pick up herbs and potting mix', garden.id, { tag: 'Errands', dueDate: date(1), estimate: 30 });
    const planting = task('Plant the kitchen herbs', garden.id, { tag: 'Outdoors', dueDate: date(2), estimate: 45 });
    task('Basil and flat-leaf parsley', planting.id);
    task('Mint in its own pot', planting.id);
    task('Rosemary by the sunny wall', planting.id);
    task('Make handwritten plant labels', garden.id, { tag: 'Creative', estimate: 20 });
    task('Set up a weekly watering routine', garden.id, { tag: 'Home', dueDate: date(3), estimate: 10 });
    task('Take a before-and-after photo', garden.id, { tag: 'Creative', dueDate: date(5) });
    task('Gather visual inspiration', studio.id, { tag: 'Creative', done: true });
    const design = task('Refine the homepage layout', studio.id, { tag: 'Focus', flagged: true, priority: 2, dueDate: date(), estimate: 60, plan: true });
    task('Write a friendly introduction', studio.id, { tag: 'Creative', estimate: 25, plan: true });
    task('Select three featured projects', studio.id, { tag: 'Creative', dueDate: date(1), estimate: 30 });
    task('Check the mobile navigation', studio.id, { tag: 'Focus', dueDate: date(2), estimate: 20 });
    task('Send the preview to Alex', studio.id, { dueDate: date(3), estimate: 10 });
    task('Publish the new portfolio', studio.id, { flagged: true, dueDate: date(7) });
    task('Choose a coastal walking route', trip.id, { tag: 'Outdoors', flagged: true, dueDate: date(), estimate: 20, plan: true });
    task('Book a cosy place to stay', trip.id, { dueDate: date(1), estimate: 15 });
    task('Save a few local cafés', trip.id, { tag: 'Outdoors', estimate: 10 });
    const packing = task('Pack for the weekend', trip.id, { dueDate: date(4) });
    for (const title of ['Walking shoes and a light jacket', 'Camera and spare battery', 'Water bottles and picnic blanket']) task(title, packing.id);
    task('Download the offline map', trip.id, { estimate: 5 });
    task('Pick up fresh ingredients', home.id, { tag: 'Errands', dueDate: date(), estimate: 25, plan: true });
    task('Return the library books', home.id, { tag: 'Errands', dueDate: date(1), estimate: 15 });
    task('Plan dinners for next week', home.id, { tag: 'Home', estimate: 20 });
    task('Call Mum on Sunday', home.id, { dueDate: date(3) });
    task('Read a chapter before bed', home.id, { tag: 'Focus', estimate: 20 });
    for (const title of ['Try a pottery class', 'Look up a new walking trail', 'Birthday gift idea for Sam', 'Find a home for the spare books', 'Make a playlist for the drive']) task(title, null);
    const hashes: Record<string, string> = {};
    for (const [name, b64] of Object.entries(assets)) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      hashes[name] = await storeFile(new File([bytes], `${name}.jpg`, { type: 'image/jpeg' }));
    }
    const note = createItem(db, device, { title: 'A weekend by the coast', type: 'note', parentId: notebook.id,
      note: `![Coastal walking inspiration](/api/blobs/${hashes['coastal-weekend']})\n\n## A little room to breathe\nTwo days of ocean air, good coffee and unhurried walks. Leave the schedule light and enjoy the journey.\n\n### Ideas for the weekend\n- Take the scenic route and stop when the view feels right.\n- Pack a picnic for a sheltered beach.\n- Bring the camera, but leave room to simply look.\n\n### Bring along\nWalking shoes, a warm layer, water bottles and a notebook.\n\n**Weekend intention:** fewer plans, more fresh air.` });
    const recipe = createItem(db, device, { title: 'Lemon & tomato orzo', type: 'note', parentId: recipes.id,
      metadata: { noteMode: 'recipe', recipe: { servings: 4, units: 'original' } },
      note: `![Lemon and tomato orzo with spinach and feta](/api/blobs/${hashes['lemon-orzo']})\n\nA bright, easy dinner with sweet tomatoes, fresh greens and a lemony finish.\n\n## Ingredients\nServes: 4\n\n- 300 g orzo\n- 400 g cherry tomatoes\n- 100 g baby spinach\n- 120 g feta\n- 30 ml olive oil\n- 2 cloves garlic\n- 1 lemon\n- 15 g fresh basil\n\n## Method\n1. Cook the orzo in salted water until tender. Reserve a little cooking water, then drain.\n2. Warm the olive oil in a large pan. Add the chopped garlic and halved tomatoes; cook for 8 minutes.\n3. Stir in the spinach until wilted, then add the orzo, lemon zest and juice. Loosen with a splash of cooking water.\n4. Finish with crumbled feta and torn basil. Season to taste and serve warm.\n\n## Notes\nLovely with a crisp green salad. Add the feta just before serving.` });
    createItem(db, device, { title: 'Ideas for a calm workspace', type: 'note', parentId: notebook.id, note: '## Keep it simple\n- A clear desk and a good lamp\n- One notebook for passing thoughts\n- A plant by the window\n\nMake it easy to begin, and easy to put everything away.' });
    createItem(db, device, { title: 'Sunday pancake notes', type: 'note', parentId: recipes.id, note: '## Next time\nTry lemon zest in the batter. Serve with yoghurt, berries and a little maple syrup.' });
    await ensureNoteThumb(note.id); await ensureNoteThumb(recipe.id);
    // Completed example time blocks, written through the normal record-op path.
    for (const [projectId, itemId, hour, minutes] of [[studio.id, design.id, 9, 55], [garden.id, pots.id, 11, 20], [studio.id, design.id, 14, 35]] as const) {
      const start = date(-1, hour), end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
      const sessionId = crypto.randomUUID();
      for (const [id, kind, item, parent] of [[sessionId, 'session', projectId, null], [crypto.randomUUID(), 'task', itemId, sessionId]])
        recordRecordOp(db, device, 'timelog', id, { id, item_id: item, user_id: null, start_time: start, end_time: end, note: null, created_at: start, updated_at: new Date().toISOString(), kind, session_id: parent, deleted: false });
    }
    const { presetFeatures } = await import('/src/lib/features.ts');
    useStore.getState().setUiPrefs({ complexity: 'custom', features: {
      ...presetFeatures('advanced'), viewControls: { desktop: false, mobile: false },
      showBar: { desktop: false, mobile: false }, nlCommands: { desktop: false, mobile: false },
    } });
    const { getPrefs, savePrefs } = await import('/src/lib/views.ts');
    savePrefs('today', { ...getPrefs('today'), sort: 'due' });
    useStore.getState().bump(); await flushPersist();
    return { garden: garden.id, notebook: notebook.id, note: note.id, recipe: recipe.id,
      count: db.get('SELECT count(*) AS n FROM items WHERE deleted = 0').n };
  }, { corePath: `/@fs/${resolve('packages/core/src/index.ts')}`, assets });
  const downloadEvent = page.waitForEvent('download');
  await page.evaluate(async () => { const { exportBackup } = await import('/src/lib/backup.ts'); await exportBackup(); });
  await (await downloadEvent).saveAs(`${output}/carbon-demo-backup.json`);
  writeFileSync(`${output}/workspace.json`, JSON.stringify(ids, null, 2));
  const shots = [ ['01-today', '/today'], ['02-projects', `/project/${ids.garden}`], ['03-daily-plan', '/plan'],
    ['04-notebooks', `/project/${ids.notebook}`], ['05-illustrated-note', `/note/${ids.note}`], ['06-recipe', `/note/${ids.recipe}`] ];
  for (const [name, width, height, scale] of [['phone', 432, 768, 2.5], ['tablet-7', 1024, 576, 1.875], ['tablet-10', 1280, 720, 2]] as const) {
    // Different CSS viewport sizes exercise the real responsive layouts.
    const captureContext = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, isMobile: name === 'phone', hasTouch: true, storageState: await context.storageState({ indexedDB: true }) });
    const capturePage = await captureContext.newPage();
    await capturePage.route('**/api/health', route => route.fulfill({ json: { role: 'single', status: 'ok' } }));
    mkdirSync(`${output}/${name}`, { recursive: true });
    for (const [label, path] of shots) {
      await capturePage.goto(path);
      await capturePage.waitForFunction(() => (window as any).__carbonE2e?.ready);
      await expect(capturePage.locator('main')).toBeVisible();
      await capturePage.evaluate(async () => { await document.fonts.ready; });
      if (label === '05-illustrated-note' || label === '06-recipe') {
        await expect(capturePage.locator('main img').first()).toBeVisible();
        await capturePage.waitForFunction(() => [...document.querySelectorAll('main img')].every((i: any) => i.complete && i.naturalWidth > 0));
      }
      if (label === '06-recipe' && name === 'phone') {
        await capturePage.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(capturePage.locator('main img').first()).toBeVisible();
      }
      await capturePage.screenshot({ path: `${output}/${name}/${label}.png`, animations: 'disabled' });
    }
    await captureContext.close();
  }
  await context.close();
});
