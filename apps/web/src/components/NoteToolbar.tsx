import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link2,
  ImagePlus,
} from 'lucide-react';
import { cn } from '@/lib/cn';

function btnCls(active: boolean) {
  return cn(
    'rounded-lg p-1.5 text-text-faint hover:bg-surface-2 hover:text-text',
    active && 'bg-surface-2 text-text',
  );
}

const Divider = () => <span className="mx-1 h-4 w-px bg-border" />;

/** Formatting toolbar shown above the Tiptap (rendered) editor. Every button uses
 *  onMouseDown={preventDefault} so clicking it doesn't blur the editor first — a
 *  real blur would collapse the text selection the command is meant to act on. */
export function NoteToolbar({
  editor,
  onInsertImage,
}: {
  editor: Editor | null;
  onInsertImage: () => void;
}) {
  const state = useEditorState({
    editor,
    selector: (ctx) => {
      const e = ctx.editor;
      if (!e || e.isDestroyed) return null;
      try {
        return {
          bold: e.isActive('bold'),
          italic: e.isActive('italic'),
          underline: e.isActive('underline'),
          strike: e.isActive('strike'),
          code: e.isActive('code'),
          h1: e.isActive('heading', { level: 1 }),
          h2: e.isActive('heading', { level: 2 }),
          h3: e.isActive('heading', { level: 3 }),
          bulletList: e.isActive('bulletList'),
          orderedList: e.isActive('orderedList'),
          blockquote: e.isActive('blockquote'),
          link: e.isActive('link'),
        };
      } catch {
        // Destroyed mid-selector (TipTap unmount race) — hide the toolbar for this tick.
        return null;
      }
    },
  });

  if (!editor || !state) return null;

  function setLink() {
    const previous = editor!.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL', previous ?? 'https://');
    if (url === null) return;
    if (!url.trim()) {
      editor!.chain().focus().unsetLink().run();
      return;
    }
    editor!.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }

  const btn = (
    active: boolean,
    label: string,
    onClick: () => void,
    Icon: typeof Bold,
  ) => (
    <button
      key={label}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={btnCls(active)}
      aria-label={label}
      title={label}
    >
      <Icon size={14} />
    </button>
  );

  return (
    <div className="mb-1 flex flex-wrap items-center gap-0.5 border-b border-border pb-1">
      {btn(state.bold, 'Bold', () => editor.chain().focus().toggleBold().run(), Bold)}
      {btn(state.italic, 'Italic', () => editor.chain().focus().toggleItalic().run(), Italic)}
      {btn(state.underline, 'Underline', () => editor.chain().focus().toggleUnderline().run(), Underline)}
      {btn(state.strike, 'Strikethrough', () => editor.chain().focus().toggleStrike().run(), Strikethrough)}
      {btn(state.code, 'Inline code', () => editor.chain().focus().toggleCode().run(), Code)}
      <Divider />
      {btn(state.h1, 'Heading 1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), Heading1)}
      {btn(state.h2, 'Heading 2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), Heading2)}
      {btn(state.h3, 'Heading 3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), Heading3)}
      <Divider />
      {btn(state.bulletList, 'Bullet list', () => editor.chain().focus().toggleBulletList().run(), List)}
      {btn(state.orderedList, 'Numbered list', () => editor.chain().focus().toggleOrderedList().run(), ListOrdered)}
      {btn(state.blockquote, 'Blockquote', () => editor.chain().focus().toggleBlockquote().run(), Quote)}
      <Divider />
      {btn(state.link, 'Link', setLink, Link2)}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onInsertImage}
        className={btnCls(false)}
        aria-label="Insert image"
        title="Insert image"
      >
        <ImagePlus size={14} />
      </button>
    </div>
  );
}
