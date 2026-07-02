import { useNavigate } from 'react-router-dom';
import { Cloud, CloudOff, RefreshCw, AlertCircle, LogIn, ShieldAlert } from 'lucide-react';
import { useStore } from '@/lib/store';
import { getServerConfig } from '@/lib/config';
import { syncNow } from '@/lib/sync';
import { cn } from '@/lib/cn';

export function SyncIndicator() {
  const status = useStore((s) => s.syncStatus);
  const syncError = useStore((s) => s.syncError);
  const currentUser = useStore((s) => s.currentUser);
  const navigate = useNavigate();
  const configured = !!getServerConfig().url;

  // Resolve the indicator from connection + auth state.
  let icon: React.ReactNode;
  let label: string;
  let cls: string;
  let onClick: () => void;
  let title: string;

  if (!configured) {
    icon = <CloudOff size={16} />;
    label = 'Local only';
    cls = 'text-text-faint';
    title = 'Configure a server in Settings to sync';
    onClick = () => navigate('/settings');
  } else if (!currentUser) {
    icon = <LogIn size={16} />;
    label = 'Sign in';
    cls = 'text-warning';
    title = 'Server requires sign-in — open Settings';
    onClick = () => navigate('/settings');
  } else if (currentUser.open) {
    icon = <ShieldAlert size={16} />;
    label = 'Open server';
    cls = 'text-warning';
    title = 'Server has no accounts (no login). Click to sync; add a user in Settings.';
    onClick = () => void syncNow();
  } else {
    const meta = {
      idle: { icon: <Cloud size={16} />, label: 'Synced', cls: 'text-text-muted' },
      syncing: { icon: <RefreshCw size={16} className="animate-spin" />, label: 'Syncing', cls: 'text-text-muted' },
      error: { icon: <AlertCircle size={16} />, label: 'Sync error', cls: 'text-danger' },
      offline: { icon: <CloudOff size={16} />, label: 'Offline', cls: 'text-warning' },
      disabled: { icon: <Cloud size={16} />, label: 'Synced', cls: 'text-text-muted' },
    }[status];
    icon = meta.icon;
    label = meta.label;
    cls = meta.cls;
    title =
      status === 'error' && syncError
        ? `Sync error: ${syncError} — click to retry`
        : `Signed in as ${currentUser.username} — click to sync`;
    onClick = () => void syncNow();
  }

  return (
    <button
      data-testid="sync-status"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-surface-2',
        cls,
      )}
      title={title}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
