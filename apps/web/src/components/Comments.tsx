import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Send, Trash2, Paperclip, X } from 'lucide-react';
import {
  listComments,
  listUsers,
  addComment,
  deleteComment,
  addAttachment,
  type User,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { useStore, getCurrentUserId } from '@/lib/store';
import { storeFile, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB } from '@/lib/blobs';
import { cn } from '@/lib/cn';
import { Attachments } from './Attachments';
import { Markdown } from './Markdown';
import { avatarInitial } from './Avatar';

const MENTION_RE = /@([a-zA-Z0-9_.-]+)/g;

function resolveMentions(body: string, roster: User[]): string[] {
  const names = new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase()));
  return roster.filter((u) => names.has(u.username.toLowerCase())).map((u) => u.id);
}

function Avatar({ user, name }: { user?: User; name: string }) {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ background: user?.avatar_color || 'var(--text-faint)' }}
    >
      {user ? avatarInitial(user) : name.charAt(0).toUpperCase()}
    </span>
  );
}

export function Comments({ itemId }: { itemId: string }) {
  const me = useStore((s) => s.currentUser);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  const data = useQuery(
    (db) => ({ comments: listComments(db, itemId), roster: listUsers(db) }),
    [itemId],
  );
  if (!data) return null;
  const { comments, roster } = data;
  const usersById = new Map(roster.map((u) => [u.id, u]));
  const knownNames = new Set(roster.map((u) => u.username.toLowerCase()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text && pending.length === 0) return;
    const comment = mutate((db, dev) =>
      addComment(db, dev, {
        itemId,
        authorId: me?.id ?? null,
        body: text,
        mentions: resolveMentions(text, roster),
      }),
    );
    setBody('');
    setError(null);
    const files = pending;
    setPending([]);
    for (const file of files) {
      const hash = await storeFile(file);
      mutate((db, dev) =>
        addAttachment(db, dev, {
          parentType: 'comment',
          parentId: comment.id,
          itemId,
          filename: file.name,
          mimeType: file.type || null,
          size: file.size,
          hash,
          createdBy: getCurrentUserId(),
        }),
      );
    }
  }

  return (
    <div>
      <span className="mb-2 block text-xs font-medium text-text-muted">
        Comments {comments.length > 0 && `(${comments.length})`}
      </span>

      <div className="space-y-3">
        {comments.map((c) => {
          const author = c.author_id ? usersById.get(c.author_id) : undefined;
          const name = author?.display_name || author?.username || 'You';
          const mine = (c.author_id ?? null) === (me?.id ?? null);
          // Anyone who can see a bot's comment may delete it (clear agent noise).
          const canDelete = mine || !!author?.is_bot;
          return (
            <div key={c.id} className="group/comment flex gap-2">
              <Avatar user={author} name={name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{name}</span>
                  <span className="text-xs text-text-faint">
                    {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                  </span>
                  {canDelete && (
                    <button
                      onClick={() => mutate((db, dev) => deleteComment(db, dev, c.id))}
                      className="ml-auto rounded p-0.5 text-text-faint opacity-0 hover:text-danger group-hover/comment:opacity-100"
                      aria-label="Delete comment"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                {c.body.trim() && <Markdown mentions={knownNames}>{c.body}</Markdown>}
                <div className="mt-1">
                  <Attachments parentType="comment" parentId={c.id} itemId={itemId} readOnly compact />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={submit}
        className={cn(
          'mt-3 rounded-xl border border-border bg-surface p-2 focus-within:border-accent',
        )}
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(e);
          }}
          rows={2}
          placeholder="Write a comment…  (@mention to notify)"
          className="min-h-0 w-full resize-none bg-transparent text-sm outline-none placeholder:text-text-faint"
        />
        {pending.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {pending.map((f, i) => (
              <span
                key={i}
                className="flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs"
              >
                {f.name}
                <button
                  type="button"
                  onClick={() => setPending(pending.filter((_, j) => j !== i))}
                  aria-label="Remove"
                >
                  <X size={11} className="text-text-faint hover:text-danger" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="cursor-pointer rounded-lg p-1.5 text-text-muted hover:bg-surface-2">
            <Paperclip size={15} />
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) {
                  const picked = Array.from(e.target.files);
                  const tooBig = picked.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
                  setError(
                    tooBig.length
                      ? `${tooBig.map((f) => f.name).join(', ')} exceeds the ${MAX_ATTACHMENT_MB} MB limit`
                      : null,
                  );
                  setPending([...pending, ...picked.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)]);
                }
                e.target.value = '';
              }}
            />
          </label>
          {error && <span className="flex-1 truncate text-xs text-danger">{error}</span>}
          {!error && <div className="flex-1" />}
          <button
            type="submit"
            disabled={!body.trim() && pending.length === 0}
            className="rounded-lg bg-accent p-2 text-accent-fg hover:bg-accent-hover disabled:opacity-40"
            aria-label="Send comment"
          >
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
