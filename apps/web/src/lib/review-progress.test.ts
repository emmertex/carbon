import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readReviewProgress,
  reviewProgressKey,
  emptyReviewProgress,
} from "./review-progress";

test("progress survives storage round trip and is isolated by account, project and review cycle", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null };
  const key = reviewProgressKey("user-a", "project-a", "cycle-1");
  const progress = {
    checklist: { tasksRelevant: true },
    reviewedTaskIds: ["task-a"],
  };
  data.set(key, JSON.stringify(progress));
  assert.deepEqual(readReviewProgress(storage, key), progress);
  for (const other of [
    reviewProgressKey("user-b", "project-a", "cycle-1"),
    reviewProgressKey("user-a", "project-b", "cycle-1"),
    reviewProgressKey("user-a", "project-a", "cycle-2"),
  ]) {
    assert.deepEqual(readReviewProgress(storage, other), emptyReviewProgress());
  }
});

test("corrupt or unavailable storage does not prevent opening reviews", () => {
  for (const value of [
    "broken",
    "null",
    '{"checklist":null,"reviewedTaskIds":[]}',
  ]) {
    assert.deepEqual(
      readReviewProgress({ getItem: () => value }, "key"),
      emptyReviewProgress(),
    );
  }
  assert.deepEqual(
    readReviewProgress(
      {
        getItem: () => {
          throw new Error("unavailable");
        },
      },
      "key",
    ),
    emptyReviewProgress(),
  );
});
