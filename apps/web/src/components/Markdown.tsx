import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';

const MENTION_RE = /@([a-zA-Z0-9_.-]+)/g;
const SKIP_PARENTS = new Set(['code', 'pre', 'a']);

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** rehype pass: wrap @mentions that resolve to a known user in <span class="mention">. */
function rehypeMentions(known: Set<string>) {
  return () => (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (!node.children) return;
      const out: HastNode[] = [];
      for (const child of node.children) {
        if (
          child.type === 'text' &&
          typeof child.value === 'string' &&
          child.value.includes('@') &&
          !SKIP_PARENTS.has(node.tagName ?? '')
        ) {
          const v = child.value;
          let last = 0;
          let m: RegExpExecArray | null;
          MENTION_RE.lastIndex = 0;
          while ((m = MENTION_RE.exec(v))) {
            if (!known.has(m[1]!.toLowerCase())) continue;
            if (m.index > last) out.push({ type: 'text', value: v.slice(last, m.index) });
            out.push({
              type: 'element',
              tagName: 'span',
              properties: { className: ['mention'] },
              children: [{ type: 'text', value: '@' + m[1] }],
            });
            last = m.index + m[0].length;
          }
          if (last === 0) out.push(child);
          else if (last < v.length) out.push({ type: 'text', value: v.slice(last) });
        } else {
          walk(child);
          out.push(child);
        }
      }
      node.children = out;
    };
    walk(tree);
  };
}

const components: Components = {
  a({ node: _node, ref: _ref, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} />
    );
  },
};

/** Render Markdown safely (raw HTML disabled). Pass `mentions` to highlight @users. */
export function Markdown({
  children,
  mentions,
  className,
}: {
  children: string;
  mentions?: Set<string>;
  className?: string;
}) {
  return (
    <div className={cn('md break-words text-sm text-text', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={mentions ? [rehypeMentions(mentions)] : []}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
