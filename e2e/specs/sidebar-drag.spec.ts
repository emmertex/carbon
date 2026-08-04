import { test, expect } from '../fixtures/client';

/**
 * Regression: dragging a sidebar project row used to reload the page. The row's
 * `<NavLink>` is an `<a>`, and dnd-kit's click canceller only `stopPropagation`s
 * (never `preventDefault`s), so react-router's onClick never ran and the browser
 * followed the href. Dragging into a folder additionally mis-computed the
 * destination group when the drop came from below the folder, leaving the
 * project as a top-level sibling instead of nesting it.
 */

/** Locator for the project row link with the given title. */
function projectLink(page: import('@playwright/test').Page, title: string) {
  return page
    .getByRole('link', { name: new RegExp(title) })
    .filter({ hasText: title });
}

/** Create a sidebar project of the given order mode via the + menu. */
async function createProject(
  page: import('@playwright/test').Page,
  mode: 'parallel' | 'sequential' | 'single',
  title: string,
) {
  await page.getByRole('button', { name: 'New folder or project' }).click();
  await page
    .getByRole('button', {
      name:
        mode === 'parallel'
          ? 'New Parallel Project'
          : mode === 'sequential'
            ? 'New Sequential Project'
            : 'New Single Action Project',
    })
    .click();
  const titleInput = page.getByTestId('task-detail').getByPlaceholder('Title');
  await titleInput.fill(title);
  await titleInput.press('Enter');
  await expect(projectLink(page, title)).toBeVisible();
}

/**
 * Press-and-hold a row at `from`, drag to `to`, release. dnd-kit's MouseSensor
 * activates after a 200ms hold (5px tolerance), so we wait on the start point
 * before moving.
 */
async function drag(
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Hold past the 200ms activation delay; nudge inside the 5px tolerance first
  // so the hold isn't cancelled as a tap.
  await page.mouse.move(from.x + 2, from.y + 2);
  await page.waitForTimeout(280);
  // Move in steps so dnd-kit's collision detection tracks the drag the whole way.
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
}

test.describe('Sidebar drag-to-reorder', () => {
  test('reordering projects does not reload the page', async ({ page }) => {
    await page.goto('/');
    // Two projects so there's something to reorder.
    await createProject(page, 'parallel', 'First Project');
    await createProject(page, 'sequential', 'Second Project');

    const firstBefore = await projectLink(page, 'First Project').boundingBox();
    const secondBefore = await projectLink(
      page,
      'Second Project',
    ).boundingBox();
    expect(firstBefore && secondBefore);

    let mainFrameNavigations = 0;
    const countNavigation = (frame: import('@playwright/test').Frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations++;
    };
    page.on('framenavigated', countNavigation);
    try {
      // Drag the lower project above the upper one.
      await drag(
        page,
        { x: secondBefore!.x + 30, y: secondBefore!.y + 10 },
        { x: firstBefore!.x + 30, y: firstBefore!.y - 5 },
      );
      await page.waitForTimeout(300);
    } finally {
      page.off('framenavigated', countNavigation);
    }

    // A post-drag click on the NavLink must not cause a browser navigation.
    expect(mainFrameNavigations).toBe(0);

    // The dragged project is now above the first one.
    await expect
      .poll(async () => {
        const first = await projectLink(page, 'First Project').boundingBox();
        const second = await projectLink(page, 'Second Project').boundingBox();
        return first && second ? second.y < first.y : null;
      })
      .toBe(true);
  });

  test('dropping a project on a folder nests it inside', async ({ page }) => {
    await page.goto('/');
    await createProject(page, 'parallel', 'Top Project');

    // Create a folder, then a second project so the project being dragged is
    // unambiguously below the folder.
    await page.getByRole('button', { name: 'New folder or project' }).click();
    await page.getByRole('button', { name: 'New Folder', exact: true }).click();
    // A new folder starts in inline-edit mode; commit it so the drag target is
    // the folder row, not the editor's input field.
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await expect(page.getByText('New Folder', { exact: true })).toBeVisible();
    await createProject(page, 'sequential', 'Folder Project');

    const folderBox = await page
      .getByText('New Folder', { exact: true })
      .boundingBox();
    const projectBox = await projectLink(page, 'Folder Project').boundingBox();
    expect(folderBox && projectBox);

    // Drag the lower project up onto the folder header.
    await drag(
      page,
      { x: projectBox!.x + 30, y: projectBox!.y + 10 },
      { x: folderBox!.x + 30, y: folderBox!.y + 10 },
    );

    // The project is now nested: collapsing the folder hides it. (Before the
    // fix the project stayed at top level and remained visible when collapsed.)
    await page.getByRole('button', { name: 'Collapse' }).first().click();
    await expect(projectLink(page, 'Folder Project')).toHaveCount(0);
    await expect(projectLink(page, 'Top Project')).toHaveCount(1);
    await page.getByRole('button', { name: 'Expand' }).first().click();
    await expect(projectLink(page, 'Folder Project')).toHaveCount(1);
  });
});
