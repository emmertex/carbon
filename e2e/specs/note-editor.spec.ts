import { test, expect } from "../fixtures/client";
import { addTask } from "../helpers/scenario";

for (const width of [1280, 390]) {
  test(`image picker and note layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/all");
    await addTask(page, "Editor regression");
    const row = page
      .getByTestId("task-row")
      .filter({ hasText: "Editor regression" })
      .first();
    await row.click();
    await row.click();
    const pane = page.getByTestId("task-detail");
    await pane.getByRole("button", { name: "Note", exact: true }).click();
    const readView = pane.getByRole("button", {
      name: "Notes, click or press Enter to edit",
    });
    const emptyBox = await readView.boundingBox();
    const emptyAttachments = await pane
      .getByText("Add attachment", { exact: true })
      .boundingBox();
    expect(emptyAttachments!.y - (emptyBox!.y + emptyBox!.height)).toBeLessThan(
      150,
    );
    await pane
      .getByRole("button", { name: "Notes, click or press Enter to edit" })
      .click();
    const editor = pane.locator(".tiptap-notes");
    await expect(editor).toBeVisible();
    await editor.fill(
      Array.from({ length: 100 }, (_, i) => `Long content line ${i}`).join(
        "\n",
      ),
    );
    const chooserEvent = page.waitForEvent("filechooser");
    await pane
      .getByRole("button", { name: "Insert image", exact: true })
      .click();
    const chooser = await chooserEvent;
    // Headless file choosers do not produce the OS dialog's focus loss.
    await editor.evaluate((el: HTMLElement) => el.blur());
    await expect(editor).toBeVisible();
    await chooser.setFiles({
      name: "inline.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    const image = editor.locator("img");
    await expect(image).toHaveAttribute("src", /^blob:/);
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBe(1);
    const editorBox = await editor.boundingBox();
    const attachmentBox = await pane
      .getByText("Add attachment", { exact: true })
      .boundingBox();
    expect(attachmentBox!.y).toBeGreaterThan(editorBox!.y + editorBox!.height);
    await editor.evaluate((el: HTMLElement) => el.blur());
    await expect(pane.locator(".md img")).toHaveCount(1);
    await pane
      .getByRole("button", { name: "Notes, click or press Enter to edit" })
      .click();
    await expect(pane.locator(".tiptap-notes img")).toHaveAttribute(
      "src",
      /^blob:/,
    );
  });
}
