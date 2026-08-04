import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import { Markdown as MarkdownExtension } from 'tiptap-markdown';
import { useEffect, useRef } from 'react';
import { storeFile, blobSrcHash, getBlobObjectUrl } from '@/lib/blobs';
import { NoteToolbar } from './NoteToolbar';

// This module is the heavy half of the Notes editor (Tiptap + ProseMirror +
// tiptap-markdown). It must ONLY be reached via a dynamic import (see
// NoteEditor.tsx's `React.lazy`) — importing it eagerly from TaskDetail would put
// the whole rich-text stack on the critical path of every task-detail open. See
// docs/internal/notes-plan.md Phase 2 / Risk #5.

/** The stock Image extension renders `src` straight into the DOM, but our image
 *  srcs are `/api/blobs/{hash}` references: a bare <img> request carries no
 *  Authorization header (Carbon auths with a Bearer token, not cookies), so the
 *  server answers 401 — and the blob may not even be uploaded yet. This node view
 *  keeps the blob reference in the document (so the saved Markdown still says
 *  `![alt](/api/blobs/{hash})`, which sync/export rely on) and resolves the
 *  DISPLAYED src through the blob store: local cache first, authed fetch second. */
const BlobImage = Image.extend({
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement('img');
      const apply = (n: typeof node) => {
        img.alt = (n.attrs.alt as string) ?? '';
        if (n.attrs.title) img.title = n.attrs.title as string;
        const src = (n.attrs.src as string) ?? '';
        const hash = blobSrcHash(src);
        if (!hash) {
          img.src = src;
          return;
        }
        img.setAttribute('data-blob-src', src);
        void getBlobObjectUrl(hash).then((url) => {
          // The node's src may have changed while resolving; only apply a
          // still-current result.
          if (url && blobSrcHash(img.getAttribute('data-blob-src')) === hash) img.src = url;
        });
      };
      apply(node);
      return {
        dom: img,
        update(updated) {
          if (updated.type.name !== node.type.name) return false;
          apply(updated);
          return true;
        },
      };
    };
  },
});

/** Read the current document as Markdown (tiptap-markdown storage). */
function getMarkdown(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor.storage as any).markdown.getMarkdown() as string;
}

/** Store a pasted/dropped/picked image and insert it at the current selection via
 *  the Tiptap command chain. `storeFile` is async, so by the time it resolves the
 *  user may have navigated away and torn the editor down — check `isDestroyed`
 *  before touching it (dispatching into a destroyed editor throws / corrupts state). */
async function insertImageFile(editor: Editor, file: File): Promise<void> {
  try {
    const hash = await storeFile(file);
    if (editor.isDestroyed) return;
    editor.chain().focus().setImage({ src: `/api/blobs/${hash}`, alt: file.name }).run();
  } catch (err) {
    console.error('[carbon] image insert failed', err);
  }
}

/** Same as insertImageFile, but for use inside editorProps.handlePaste, which only
 *  gets the raw ProseMirror EditorView (the Editor instance isn't in scope yet
 *  during useEditor's own config). Inserts directly via a transaction. */
async function insertImageFileAtView(view: EditorView, file: File): Promise<void> {
  try {
    const hash = await storeFile(file);
    if (view.isDestroyed) return;
    const { schema } = view.state;
    const node = schema.nodes.image?.create({ src: `/api/blobs/${hash}`, alt: file.name });
    if (!node) return;
    const tr = view.state.tr.replaceSelectionWith(node);
    view.dispatch(tr);
  } catch (err) {
    console.error('[carbon] image insert failed', err);
  }
}

/** Rich-text (Tiptap) editor over a Markdown string. `onDirty` fires on document
 *  updates without serializing the whole document; callers flush markdown via the
 *  getter from `onReady` at save-time, and blur always flushes the latest content.
 *
 *  `externalValue` + `externalVersion` let the parent force new content into the
 *  live editor (e.g. the "Use theirs" conflict action): bump `externalVersion` and
 *  the effect replaces the document with `externalValue`. `initialValue` only seeds
 *  the doc at mount, so without this an already-mounted editor would keep showing
 *  the stale text. */
export function TiptapEditor({
  initialValue,
  externalValue,
  externalVersion,
  onDirty,
  onBlur,
  onReady,
  autoFocus,
  placeholder,
  className,
}: {
  initialValue: string;
  externalValue?: string;
  externalVersion?: number;
  onDirty: () => void;
  onBlur: (md: string) => void;
  onReady?: (getMarkdown: () => string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  // Keep latest callbacks in refs so the editor instance (created once) always
  // calls the current handlers without needing to be recreated.
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  // The last Markdown this editor emitted; used to avoid re-applying content the
  // editor already holds (which would fight the user's typing / reset the cursor).
  const lastEmittedRef = useRef(initialValue);
  // The externalVersion already reflected in the doc. Seeded to the mount value so
  // the sync effect is a no-op on first render (the doc is created from
  // `initialValue`) and only fires when the parent *bumps* the version afterward.
  const appliedExternalVersionRef = useRef(externalVersion);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);

  const editor = useEditor({
    // Avoid create-during-render; TipTap's default can race Suspense remounts
    // (especially on mobile Chrome after a lazy chunk load) and throw into the
    // nearest error boundary on first open.
    immediatelyRender: false,
    extensions: [
      StarterKit,
      // GFM tables: without TableKit, markdown-it emits <table> HTML that the
      // StarterKit-only schema strips, concatenating cell text in the WYSIWYG view
      // while Source + read-mode (remark-gfm) still look fine.
      TableKit.configure({
        table: { resizable: false },
      }),
      BlobImage,
      Placeholder.configure({ placeholder: placeholder ?? 'Add notes…' }),
      MarkdownExtension.configure({ html: false, transformPastedText: false }),
    ],
    content: initialValue,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'md tiptap-notes text-sm text-text outline-none' },
      handlePaste(view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (!item.type.startsWith('image/')) continue;
          const file = item.getAsFile();
          // A broken/empty clipboard image item: don't claim to have handled the
          // paste (returning true would preventDefault the browser's own paste
          // with nothing actually inserted) — keep scanning other items instead.
          if (!file) continue;
          event.preventDefault();
          void insertImageFileAtView(view, file);
          return true;
        }
        return false;
      },
    },
    onUpdate() {
      dirtyRef.current = true;
      onDirtyRef.current();
    },
    onBlur({ editor }) {
      const md = flushMarkdown(editor);
      onBlurRef.current(md);
    },
  });

  function flushMarkdown(instance: Editor): string {
    // A destroyed editor has had its extensionStorage cleared, so getMarkdown()
    // would throw; the last emitted value is the best we still know.
    if (!dirtyRef.current || instance.isDestroyed) return lastEmittedRef.current;
    const md = getMarkdown(instance);
    lastEmittedRef.current = md;
    dirtyRef.current = false;
    return md;
  }

  // Force external content into the live editor when the parent *bumps* the version
  // (e.g. "Use theirs"). Only fires on a genuine change from the last-applied
  // version — never on mount (the doc already came from `initialValue`), and never
  // when the target already matches the current doc (which would fight the caret).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (externalVersion === undefined || externalValue === undefined) return;
    if (externalVersion === appliedExternalVersionRef.current) return;
    appliedExternalVersionRef.current = externalVersion;
    if (externalValue === lastEmittedRef.current) return;
    lastEmittedRef.current = externalValue;
    dirtyRef.current = false;
    editor.commands.setContent(externalValue, { emitUpdate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalVersion]);

  useEffect(() => {
    if (!editor || !onReady) return;
    onReady(() => flushMarkdown(editor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // TipTap's create-time `autofocus` races with lazy/Suspense mount and often loses
  // to focus restoration (e.g. project QuickAdd). Explicitly focus once the editor
  // is attached so Enter goes into the note body instead of submitting stray notes.
  // Guarded: a half-destroyed instance (commandManager null) must not take down the
  // note panel — Android Chrome is especially prone to this after Suspense remount.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !autoFocus) return;
    try {
      editor.commands.focus('end');
    } catch (err) {
      console.error('[carbon] editor focus failed', err);
    }
  }, [editor, autoFocus]);

  // Flush any dirty (unsaved) content on unmount, via the same onBlur path a real
  // blur would take: switching items or closing the panel while mid-autosave (before
  // the ~1.5s debounce fires) would otherwise discard the last keystrokes, since
  // nothing else reads the live document before teardown.
  //
  // Deliberately does NOT call `editor.destroy()`. Tiptap v3's `useEditor` owns the
  // instance lifecycle: its own cleanup calls `scheduleDestroy()`, which defers the
  // destroy by a tick and CANCELS it if the component remounts, handing the same
  // instance back. Destroying eagerly here nulls `commandManager` on an instance
  // `useEditor` then reuses, so the next `editor.commands.*` throws
  // "can't access property 'commands', this.commandManager is null" — which is what
  // the lazy/Suspense mount of the notes panel triggers on every open.
  useEffect(() => {
    return () => {
      if (!editor || !dirtyRef.current) return;
      const md = flushMarkdown(editor);
      onBlurRef.current(md);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function handleDrop(e: React.DragEvent) {
    if (!editor) return;
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) void insertImageFile(editor, file);
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editor) return;
    const files = [...(e.target.files ?? [])];
    for (const file of files) void insertImageFile(editor, file);
    e.target.value = '';
  }

  if (!editor) return null;

  return (
    <div className={className} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      <NoteToolbar editor={editor} onInsertImage={() => fileInputRef.current?.click()} />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFilePick}
      />
      <EditorContent editor={editor} />
    </div>
  );
}
