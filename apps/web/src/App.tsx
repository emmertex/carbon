import { useRef, useEffect } from 'react';
import { Routes, Route, Navigate, useParams, useNavigate, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { getItem } from '@carbon/core';
import { useStore } from '@/lib/store';
import { getDb } from '@/lib/db';
import { zoneForX } from '@/lib/gestures';
import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { Sidebar } from '@/components/Sidebar';
import { DetailPane } from '@/components/DetailPane';
import { Snackbar } from '@/components/Snackbar';
import { TimerBar } from '@/components/TimerBar';
import { ListView } from '@/views/ListView';
import { ContainerView } from '@/views/ContainerView';
import { ForecastView } from '@/views/ForecastView';
import { NearbyView } from '@/views/NearbyView';
import { PlanView } from '@/views/PlanView';
import { ReviewView } from '@/views/ReviewView';
import { TimeTrackedView } from '@/views/TimeTrackedView';
import { TagsView } from '@/views/TagsView';
import { SettingsView } from '@/views/SettingsView';
import { SignupView } from '@/views/SignupView';
import { HostAdminView } from '@/views/HostAdminView';
import { LandingView } from '@/views/LandingView';
import { SignInGate } from '@/components/SignInGate';
import { RenewGate } from '@/components/RenewGate';

function PerspectiveRoute() {
  const { id = '' } = useParams();
  return (
    <ListView
      key={id}
      base="all"
      perspectiveId={id}
      title="View"
      emptyText="No tasks match this view."
    />
  );
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center text-text-muted">
      <div className="animate-pulse text-sm">Loading Carbon…</div>
    </div>
  );
}

function WorkspaceNotFound({ baseDomain }: { baseDomain: string | null }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="mb-2 text-xl font-semibold">Workspace not found</h1>
      <p className="mb-6 text-sm text-text-muted">
        There's no active workspace at this address. Check the spelling, or create one.
      </p>
      {baseDomain && (
        <a
          href={`https://${baseDomain}`}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Go to {baseDomain}
        </a>
      )}
    </div>
  );
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const authRequired = useStore((s) => s.authRequired);
  const loginOpen = useStore((s) => s.loginOpen);
  const currentUser = useStore((s) => s.currentUser);
  const hostRole = useStore((s) => s.hostRole);
  const baseDomain = useStore((s) => s.baseDomain);
  const localOnly = useStore((s) => s.localOnly);
  const workspaceLocked = useStore((s) => s.workspaceLocked);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const closeDetail = useStore((s) => s.closeDetail);
  const focusQuickAdd = useStore((s) => s.focusQuickAdd);
  const navigate = useNavigate();
  const location = useLocation();

  // App-wide keyboard shortcuts (screen switching, focus quick-add, scrolling).
  useGlobalHotkeys({ navigate, focusQuickAdd });

  // Navigating to a different view always dismisses the right-hand panel — the
  // task/project detail (selectedId) or the Tags panel. Without this the panel
  // lingers on the previously selected item (e.g. open project A's detail, then
  // click project B, and A's detail stays). The selection is kept only when it
  // matches the destination container route, so creating a project and landing on
  // it with its detail open still works; likewise the Tags panel survives while
  // navigating between tag routes.
  const prevPath = useRef(location.pathname);
  useEffect(() => {
    if (location.pathname === prevPath.current) return;
    prevPath.current = location.pathname;
    const s = useStore.getState();
    const routeId = location.pathname.match(/^\/(?:project|focus)\/(.+)$/)?.[1] ?? null;
    if (s.selectedId && s.selectedId !== routeId) s.select(null);
    const onTagsRoute = location.pathname === '/tags' || location.pathname.startsWith('/tag/');
    if (s.tagsPanelOpen && !onTagsRoute) s.closeTagsPanel();
  }, [location.pathname]);

  // Pane gestures (compact only). Zones are decided by the touch-start X: the left
  // edge opens the nav drawer, the right edge runs a configurable action, and the
  // centre is left to the per-row task swipes. An open overlay can be dismissed
  // from anywhere. Edge zones span ~1/5 of the width so the swipe can start
  // inward of the Android back-gesture strip (see EDGE_FRACTION).
  const touch = useRef<{ x: number; y: number; t: number; zone: string } | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]!;
    const { paneGestures } = useStore.getState().uiPrefs;
    touch.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      zone: zoneForX(t.clientX, window.innerWidth, paneGestures),
    };
  }
  function runEdgeAction() {
    const action = useStore.getState().uiPrefs.edgeGestureAction;
    if (action === 'today') return navigate('/today');
    if (action === 'inbox') return navigate('/inbox');
    if (action === 'plan') return navigate('/plan');
    // projectRoot: climb to the top-level project of the current container.
    const m = location.pathname.match(/^\/(?:project|focus)\/(.+)$/);
    if (!m) return navigate('/today');
    let cur = getItem(getDb(), m[1]!);
    while (cur?.parent_id) {
      const parent = getItem(getDb(), cur.parent_id);
      if (!parent) break;
      cur = parent;
    }
    navigate(cur ? `/project/${cur.id}` : '/today');
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touch.current;
    touch.current = null;
    if (!start || window.innerWidth >= 1024) return; // gestures are compact-only
    const t = e.changedTouches[0]!;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Date.now() - start.t > 600) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // not a clear horizontal swipe
    const s = useStore.getState();
    // An open overlay is dismissable from anywhere.
    if (s.detailOpen) return dx > 0 ? closeDetail() : undefined;
    if (s.sidebarOpen) return dx < 0 ? setSidebarOpen(false) : undefined;
    // Otherwise act only from the edge zones; the centre belongs to task swipes.
    if (dx > 0 && start.zone === 'leftEdge') setSidebarOpen(true);
    else if (dx < 0 && start.zone === 'rightEdge') runEdgeAction();
  }

  if (!ready) return <Splash />;

  // Standalone full-page routes that bypass the app chrome.
  if (location.pathname === '/signup') return <SignupView />;
  if (location.pathname === '/host-admin') return <HostAdminView />;

  // Apex (marketing/landing host): offer signup / local-only / go-to-workspace,
  // unless the visitor already chose to use Carbon without an account.
  if (hostRole === 'apex' && !localOnly) return <LandingView />;
  // A subdomain that resolves to no active workspace.
  if (hostRole === 'unknown') return <WorkspaceNotFound baseDomain={baseDomain} />;

  // Sign-in gate: when the configured server requires a login (a /api/me 401), or
  // when the user opened it on demand (the Settings "Login" button). Local-only and
  // open-mode setups only reach this via the explicit button.
  const signedIn = !!currentUser && !currentUser.open;
  if (loginOpen || (authRequired && !signedIn)) return <SignInGate />;

  // Renew gate: the workspace's subscription has lapsed (soft lock). Shown only on a
  // real signed-in workspace — local-only/open setups have no subscription to lapse.
  if (workspaceLocked && signedIn) return <RenewGate />;

  return (
    <div
      className="flex h-full overflow-hidden bg-bg text-text"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Sidebar drawer backdrop (compact) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact top bar */}
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 lg:hidden">
          <button
            className="rounded-lg p-2 hover:bg-surface-2"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <span className="font-semibold">Carbon</span>
        </header>

        <TimerBar />

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Routes>
              <Route path="/" element={<Navigate to="/today" replace />} />
              <Route
                path="/today"
                element={
                  <ListView
                    base="today"
                    title="Today"
                    quickAdd={{ dueToday: true }}
                    emptyText="Nothing due today. Enjoy the breathing room."
                  />
                }
              />
              <Route
                path="/inbox"
                element={
                  <ListView
                    base="inbox"
                    title="Inbox"
                    quickAdd={{}}
                    emptyText="Inbox zero. Capture anything that's on your mind."
                  />
                }
              />
              <Route
                path="/flagged"
                element={
                  <ListView
                    base="flagged"
                    title="Flagged"
                    quickAdd={{ flagged: true }}
                    emptyText="No flagged tasks."
                  />
                }
              />
              <Route
                path="/all"
                element={
                  <ListView
                    base="all"
                    title="All Tasks"
                    quickAdd={{}}
                    emptyText="No tasks yet."
                  />
                }
              />
              <Route path="/view/:id" element={<PerspectiveRoute />} />
              <Route path="/forecast" element={<ForecastView />} />
              <Route path="/nearby" element={<NearbyView />} />
              <Route path="/plan" element={<PlanView />} />
              <Route path="/review" element={<ReviewView />} />
              <Route path="/time" element={<TimeTrackedView />} />
              <Route path="/project/:id" element={<ContainerView />} />
              <Route path="/focus/:id" element={<ContainerView />} />
              <Route path="/tags" element={<TagsView />} />
              <Route path="/tag/:id" element={<TagsView />} />
              <Route path="/settings" element={<SettingsView />} />
              <Route path="*" element={<Navigate to="/today" replace />} />
            </Routes>
          </main>

          <DetailPane />
        </div>
      </div>

      <Snackbar />
    </div>
  );
}
