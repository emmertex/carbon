import { tagParentPath, tagLeaf, type Tag } from '@carbon/core';

export interface TagNode {
  tag: Tag;
  leaf: string;
  depth: number;
  parentPath: string;
  children: TagNode[];
  /** Tasks carrying this tag only. */
  ownCount: number;
  /** Tasks carrying this tag or any descendant. */
  rollupCount: number;
}

/**
 * Build the tag forest from the flat, full-path tag list. Ancestors are always
 * materialized in the data, so every non-root node finds its parent.
 */
export function buildTagTree(tags: Tag[], counts: Record<string, number>): TagNode[] {
  const byPath = new Map<string, TagNode>();
  // Sorted by path so parents are created before children.
  const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));
  for (const tag of sorted) {
    byPath.set(tag.name, {
      tag,
      leaf: tagLeaf(tag.name),
      depth: tag.name.split(':').length - 1,
      parentPath: tagParentPath(tag.name),
      children: [],
      ownCount: counts[tag.id] ?? 0,
      rollupCount: counts[tag.id] ?? 0,
    });
  }
  const roots: TagNode[] = [];
  for (const node of byPath.values()) {
    const parent = node.parentPath ? byPath.get(node.parentPath) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Roll descendant counts up to ancestors (deepest first).
  const deepest = [...byPath.values()].sort((a, b) => b.depth - a.depth);
  for (const node of deepest) {
    if (node.parentPath) {
      const parent = byPath.get(node.parentPath);
      if (parent) parent.rollupCount += node.rollupCount;
    }
  }
  const sortNodes = (nodes: TagNode[]) => {
    nodes.sort((a, b) => a.leaf.localeCompare(b.leaf));
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

/** Depth-first flatten, skipping the subtrees of collapsed nodes. */
export function flattenTagTree(roots: TagNode[], collapsed: Set<string>): TagNode[] {
  const out: TagNode[] = [];
  const walk = (nodes: TagNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length && !collapsed.has(n.tag.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}
