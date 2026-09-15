import { test, expect } from "../fixtures/client";
import type { Page } from "@playwright/test";

async function seed(page: Page, tasks = true) {
  await page.evaluate(
    async (tasks) => (window as any).__carbonE2e.seedReviewProject(tasks),
    tasks,
  );
  await page.goto("/review");
}
const taskRow = (page: Page, title: string) =>
  page
    .getByTestId("task-row")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
const reviewed = (page: Page, title: string) =>
  page.getByRole("button", { name: `Reviewed: ${title}`, exact: true });
async function action(page: Page, title: string, name: string) {
  await taskRow(page, title).hover();
  await taskRow(page, title)
    .getByRole("button", { name: "More actions" })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function saved(page: Page) {
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
}

test("empty project keeps its single confirmation and finishes inline", async ({
  page,
}) => {
  await seed(page, false);
  await page
    .getByRole("button", { name: "Finish review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm review", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Confirm there are no tasks" })
    .check();
  await saved(page);
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Confirm there are no tasks" }),
  ).toBeChecked();
  await expect(page.getByRole("link", { name: "Go to project" })).toBeVisible();
  await page
    .getByRole("button", { name: "Finish review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review complete", exact: true }),
  ).toBeVisible();
});

test("tasks stay in one workspace with independent review controls and optional prompts", async ({
  page,
}) => {
  await seed(page);
  await expect(page.getByTestId("task-row")).toHaveCount(3);
  await expect(page.getByText("Review context notes")).toBeVisible();
  await reviewed(page, "Nested review task").click();
  await expect(taskRow(page, "Nested review task")).toHaveAttribute(
    "data-status",
    "active",
  );
  await page.getByRole("checkbox", { name: "Not reviewed only" }).check();
  await expect(taskRow(page, "Nested review task")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Not reviewed only" }).uncheck();
  await page.getByText("Review prompts", { exact: false }).click();
  await page
    .getByRole("checkbox", { name: "Are these tasks still relevant?" })
    .check();
  await saved(page);
  await page.reload();
  await expect(reviewed(page, "Nested review task")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByText("Review prompts", { exact: false }).click();
  await expect(
    page.getByRole("checkbox", { name: "Are these tasks still relevant?" }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Finish review", exact: true })
    .click();
  await expect(
    page.getByText("2 open tasks are not marked reviewed.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm review", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("task-row")).toHaveCount(3);
});

test("standard row menus add subtasks, defer and drop; details feed the summary", async ({
  page,
}) => {
  await seed(page);
  await action(page, "Nested review task", "Add subtask");
  await page
    .getByPlaceholder("Subtask title", { exact: true })
    .fill("New review subtask");
  await page.getByPlaceholder("Subtask title", { exact: true }).press("Enter");
  await expect(taskRow(page, "New review subtask")).toBeVisible();
  await action(page, "Nested review task", "Defer…");
  await page.getByLabel("Defer date").fill("2030-02-03");
  await page.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(reviewed(page, "Nested review task")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .getByRole("button", { name: "Grandchild review task", exact: true })
    .click();
  const detail = page.getByTestId("task-detail");
  await expect(detail).toBeVisible();
  await detail
    .getByPlaceholder("Title", { exact: true })
    .fill("Edited from review");
  await detail.getByPlaceholder("Title", { exact: true }).blur();
  await detail.getByRole("button", { name: "Close", exact: true }).click();
  await action(page, "New review subtask", "Drop task");
  await page
    .getByRole("button", { name: "Finish review", exact: true })
    .click();
  const summary = page.getByRole("region", { name: "Review summary" });
  await expect(
    summary.getByText("Title edited", { exact: true }),
  ).toBeVisible();
  await expect(
    summary.getByText("Defer date changed", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Keep reviewing", exact: true })
    .click();
  await expect(taskRow(page, "Edited from review")).toBeVisible();
});

for (const target of ["Root review task", "Nested review task"]) {
  test(`completing ${target} completes all its subtasks`, async ({ page }) => {
    await seed(page);
    await taskRow(page, target)
      .getByRole("button", { name: "Mark complete", exact: true })
      .click();
    await expect(taskRow(page, "Grandchild review task")).toHaveCount(0);
    await expect(taskRow(page, "Nested review task")).toHaveCount(0);
    await saved(page);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Review", exact: true }),
    ).toBeVisible();
    const count = target === "Root review task" ? 0 : 1;
    await expect(page.getByTestId("task-row")).toHaveCount(count);
    if (!count) {
      await page
        .getByRole("checkbox", { name: "Confirm there are no tasks" })
        .check();
      await page
        .getByRole("button", { name: "Finish review", exact: true })
        .click();
      await expect(
        page
          .getByRole("region", { name: "Review summary" })
          .getByText("Completed", { exact: true }),
      ).toHaveCount(3);
    }
  });
}

test("project selection preserves progress and mobile layout fits the screen", async ({
  page,
}, testInfo) => {
  await seed(page);
  await reviewed(page, "Nested review task").click();
  await saved(page);
  const secondId = await page.evaluate(async () =>
    (window as any).__carbonE2e.seedReviewProject(false),
  );
  await expect(
    page.getByRole("navigation", { name: "Projects to review" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Projects to review" })
    .getByRole("button")
    .nth(1)
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Confirm there are no tasks" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Projects to review" })
    .getByRole("button")
    .first()
    .click();
  await expect(reviewed(page, "Nested review task")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({
    path: testInfo.outputPath("review-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByLabel("Project to review", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Project to review", { exact: true })
    .selectOption(secondId);
  await expect(
    page.getByRole("checkbox", { name: "Confirm there are no tasks" }),
  ).toBeVisible();
  await page
    .getByLabel("Project to review", { exact: true })
    .selectOption({ index: 0 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("review-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await taskRow(page, "Nested review task")
    .getByRole("button", { name: "More actions" })
    .click();
  await page.getByRole("button", { name: "Add subtask", exact: true }).click();
  await expect(
    page.getByPlaceholder("Subtask title", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel task action" }).click();
  await page
    .getByRole("button", { name: "Nested review task", exact: true })
    .click();
  await expect(page.getByTestId("task-detail")).toBeVisible();
});

test("review progress syncs between two devices", async ({ page, browser }) => {
  const { signInWithApi, syncNow } = await import("../helpers/scenario");
  const { serverUrl, e2eCredentials, installE2eInit } =
    await import("../helpers/reset");
  const { username, password } = e2eCredentials();
  await signInWithApi(page, serverUrl(), username, password);
  await seed(page);
  await reviewed(page, "Root review task").click();
  await saved(page);
  await syncNow(page);
  const context = await browser.newContext();
  try {
    await installE2eInit(context);
    const second = await context.newPage();
    await second.goto("http://localhost:3042");
    await signInWithApi(second, serverUrl(), username, password);
    await syncNow(second);
    await second.goto("http://localhost:3042/review");
    await expect(reviewed(second, "Root review task")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await reviewed(second, "Nested review task").click();
    await saved(second);
    await syncNow(second);
    await syncNow(page);
    await expect(reviewed(page, "Nested review task")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await context.close();
  }
});

test("subtasks remain directly below their own root when more roots are added", async ({
  page,
}) => {
  await seed(page);
  await page.getByTestId("quick-add").fill("Second root task");
  await page.getByTestId("quick-add").press("Enter");
  await expect(page.getByTestId("task-row")).toHaveCount(4);
  expect(
    await page
      .getByTestId("task-row")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-title"))),
  ).toEqual([
    "Root review task",
    "Nested review task",
    "Grandchild review task",
    "Second root task",
  ]);
});

test("project toolbar starts an early review and clears the target on completion", async ({ page }) => {
  await page.getByRole("button", { name: "New folder or project" }).click();
  await page.getByRole("button", { name: "New Parallel Project" }).click();
  await page.waitForURL("**/project/**");
  const projectId = new URL(page.url()).pathname.split("/").pop()!;
  const pane = page.getByTestId("task-detail");
  await expect(pane).toBeVisible();
  await pane.getByRole("button", { name: "Start Review", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/review\\?project=${projectId}$`));
  await expect(pane).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "New Project", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Confirm there are no tasks" }).check();
  await saved(page);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Confirm there are no tasks" })).toBeChecked();
  await page.getByRole("button", { name: "Finish review", exact: true }).click();
  await page.getByRole("button", { name: "Confirm review", exact: true }).click();
  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByRole("heading", { name: "Review complete", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Nothing to review right now.")).toBeVisible();
});

test("project toolbar targets the chosen project while another review is open", async ({ page }) => {
  await seed(page);
  await page.getByRole("button", { name: "New folder or project" }).click();
  await page.getByRole("button", { name: "New Parallel Project" }).click();
  await page.waitForURL("**/project/**");
  await page.getByTestId("task-detail").getByRole("button", { name: "Start Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New Project", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Confirm there are no tasks" }).check();
  await page.getByRole("button", { name: "Finish review", exact: true }).click();
  await page.getByRole("button", { name: "Confirm review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review fixture", exact: true })).toBeVisible();
  await taskRow(page, "Root review task").getByRole("button", { name: "Root review task", exact: true }).click();
  await expect(page.getByTestId("task-detail")).toBeVisible();
  await expect(page.getByTestId("task-detail").getByRole("button", { name: "Start Review", exact: true })).toHaveCount(0);
});
