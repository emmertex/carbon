// Legacy localStorage format, retained only to migrate pre-table review progress.
export interface ReviewProgress {
  checklist: Record<string, boolean>;
  reviewedTaskIds: string[];
}

export const emptyReviewProgress = (): ReviewProgress => ({
  checklist: {},
  reviewedTaskIds: [],
});

// One entry per project and review cycle. Completing a review starts a fresh cycle.
export function reviewProgressKey(
  identity: string,
  projectId: string,
  cycle: string,
): string {
  return `carbon.review.${encodeURIComponent(projectId)}.${encodeURIComponent(cycle)}::${identity}`;
}

export function readReviewProgress(
  storage: Pick<Storage, "getItem">,
  key: string,
): ReviewProgress {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value.checklist !== "object" ||
      !value.checklist ||
      !Array.isArray(value.reviewedTaskIds)
    )
      return emptyReviewProgress();
    return {
      checklist: Object.fromEntries(
        Object.entries(value.checklist).filter(
          ([, v]) => typeof v === "boolean",
        ),
      ) as Record<string, boolean>,
      reviewedTaskIds: value.reviewedTaskIds.filter(
        (id: unknown): id is string => typeof id === "string",
      ),
    };
  } catch {
    return emptyReviewProgress();
  }
}
