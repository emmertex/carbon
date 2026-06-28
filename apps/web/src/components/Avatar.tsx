import { cn } from '@/lib/cn';

interface AvatarUser {
  display_name?: string | null;
  username?: string | null;
  avatar_color?: string | null;
  avatar_initial?: string | null;
}

/** The initial shown in a user's avatar: custom letter, else first char of name. */
export function avatarInitial(u: AvatarUser): string {
  if (u.avatar_initial) return u.avatar_initial.toUpperCase();
  const name = u.display_name || u.username || '?';
  return name.charAt(0).toUpperCase();
}

const SIZES = {
  xs: 'h-4 w-4 text-[9px]',
  sm: 'h-5 w-5 text-[10px]',
  md: 'h-6 w-6 text-xs',
  lg: 'h-7 w-7 text-sm',
};

export function Avatar({
  user,
  size = 'md',
  className,
  title,
}: {
  user: AvatarUser;
  size?: keyof typeof SIZES;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        SIZES[size],
        className,
      )}
      style={{ background: user.avatar_color || 'var(--text-faint)' }}
      title={title ?? user.display_name ?? user.username ?? undefined}
    >
      {avatarInitial(user)}
    </span>
  );
}
