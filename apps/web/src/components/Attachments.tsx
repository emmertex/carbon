import { useEffect, useState } from 'react';
import { Paperclip, Download, Trash2, FileText } from 'lucide-react';
import {
  listAttachmentsFor,
  addAttachment,
  deleteAttachment,
  type Attachment,
  type AttachmentParent,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { getCurrentUserId } from '@/lib/store';
import { storeFile, getBlob, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB } from '@/lib/blobs';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function useObjectUrl(att: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let current: string | null = null;
    void getBlob(att.hash, att.mime_type).then((blob) => {
      if (blob && !revoked) {
        current = URL.createObjectURL(blob);
        setUrl(current);
      }
    });
    return () => {
      revoked = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [att.hash, att.mime_type]);
  return url;
}

function ImageAttachment({ att, onDelete }: { att: Attachment; onDelete: () => void }) {
  const url = useObjectUrl(att);
  return (
    <div className="group/att relative overflow-hidden rounded-lg border border-border">
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={att.filename} className="h-24 w-24 object-cover" />
        </a>
      ) : (
        <div className="flex h-24 w-24 items-center justify-center bg-surface-2 text-xs text-text-faint">
          …
        </div>
      )}
      <button
        onClick={onDelete}
        className="absolute right-1 top-1 rounded bg-black/50 p-1 text-white opacity-0 group-hover/att:opacity-100"
        aria-label="Remove attachment"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function FileAttachment({ att, onDelete }: { att: Attachment; onDelete: () => void }) {
  async function download() {
    const blob = await getBlob(att.hash, att.mime_type);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="group/att flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
      <FileText size={15} className="shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1 truncate">{att.filename}</span>
      <span className="text-xs text-text-faint">{formatSize(att.size)}</span>
      <button onClick={download} className="text-text-muted hover:text-accent" aria-label="Download">
        <Download size={15} />
      </button>
      <button
        onClick={onDelete}
        className="text-text-faint opacity-0 hover:text-danger group-hover/att:opacity-100"
        aria-label="Remove"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function Attachments({
  parentType,
  parentId,
  itemId,
  compact = false,
  readOnly = false,
}: {
  parentType: AttachmentParent;
  parentId: string;
  itemId: string;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const attachments =
    useQuery((db) => listAttachmentsFor(db, parentType, parentId), [parentType, parentId]) ?? [];
  const [error, setError] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    const tooBig = Array.from(files).filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    setError(
      tooBig.length
        ? `${tooBig.map((f) => f.name).join(', ')} exceeds the ${MAX_ATTACHMENT_MB} MB limit`
        : null,
    );
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      const hash = await storeFile(file);
      mutate((db, dev) =>
        addAttachment(db, dev, {
          parentType,
          parentId,
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

  const images = attachments.filter((a) => (a.mime_type ?? '').startsWith('image/'));
  const files = attachments.filter((a) => !(a.mime_type ?? '').startsWith('image/'));

  if (readOnly && attachments.length === 0) return null;

  return (
    <div>
      {!compact && !readOnly && (
        <span className="mb-1 block text-xs font-medium text-text-muted">Attachments</span>
      )}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((a) => (
            <ImageAttachment
              key={a.id}
              att={a}
              onDelete={() => mutate((db, dev) => deleteAttachment(db, dev, a.id))}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {files.map((a) => (
            <FileAttachment
              key={a.id}
              att={a}
              onDelete={() => mutate((db, dev) => deleteAttachment(db, dev, a.id))}
            />
          ))}
        </div>
      )}
      {!readOnly && (
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-text-muted hover:bg-surface-2">
          <Paperclip size={13} /> {compact ? 'Attach' : 'Add attachment'}
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
