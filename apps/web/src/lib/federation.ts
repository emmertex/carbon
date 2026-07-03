import type { Permission } from '@carbon/core';
import { getServerConfig, authHeaders } from './config';

// Federation client helpers for the Settings → Federation panel. Thin wrappers over
// the server's `/api/federation/*` REST surface (session/admin-authed; the server
// enforces the gates — these calls are a convenience, never the authority). Shaped
// like `lib/notices.ts`.

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}

export type FederationPolicy = 'workspace_only' | 'admin_whitelist' | 'user_open';
/** The effective host ceiling (Gate 1) as resolved server-side. */
export type FederationMode = 'off' | 'intra_server' | 'cross_server';

/** Which admin-managed list a peer belongs to: `allow` (gates who members may reach
 *  under `admin_whitelist`) or `deny` (always-blocked, under BOTH policies). */
export type PeerListType = 'allow' | 'deny';

export interface FederationPeer {
  id: string;
  base_url: string;
  subdomain: string | null;
  label: string | null;
  approved_by: string | null;
  approved_at: string | null;
  list_type: PeerListType;
  deleted: boolean;
}

export interface FederationConfig {
  policy: FederationPolicy;
  /** The effective host ceiling (read-only; set by the server operator). */
  ceiling: FederationMode;
  /** The admin allow-list (consulted under `admin_whitelist`). */
  allow: FederationPeer[];
  /** The admin deny-list (always-blocked, under BOTH `user_open` and `admin_whitelist`). */
  deny: FederationPeer[];
  /** Whether a cross-server (L3, dotted-address) offer is currently possible. */
  canOfferCrossServer: boolean;
}

export interface FederationLinkRootView {
  root_item_id: string;
  permission: Permission;
  title: string | null;
}

export interface FederationLinkView {
  id: string;
  direction: 'outbound' | 'inbound';
  status: 'pending' | 'active' | 'revoked';
  peer_label: string;
  roots: FederationLinkRootView[];
}

/** A user on a same-host, mutually-whitelisted peer, as returned by `/directory`.
 *  `address` is the ready-to-offer `username@subdomain` form. */
export interface FederationDirectoryUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_color: string | null;
  address: string;
}

async function reqJson<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = getServerConfig();
  if (!cfg.url) throw new Error('no server configured');
  const res = await fetch(joinUrl(cfg.url, path), {
    ...init,
    headers: { ...authHeaders(cfg), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    // Surface the server's structured error/reason (e.g. a gate rejection) so the UI
    // can show WHY an offer was denied, not just a status code.
    let detail: { error?: string; reason?: string } = {};
    try {
      detail = (await res.json()) as { error?: string; reason?: string };
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(detail.reason || detail.error || `request failed: ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** Whether the workspace can federate at all — the gate for showing the in-dialog
 *  "share with a workspace" affordance. The server still enforces every finer gate on
 *  submit; this only decides whether to offer the affordance vs. leave a dead-end. */
export function canFederate(config: Pick<FederationConfig, 'policy' | 'ceiling'>): boolean {
  return config.policy !== 'workspace_only' && config.ceiling !== 'off';
}

/** Same-host allow-list peers with a usable subdomain — the candidates to probe for a
 *  mutual link (and thus a share-picker roster). */
export function offerablePeerSubdomains(config: Pick<FederationConfig, 'allow'>): string[] {
  return config.allow.filter((p) => !p.deleted && p.subdomain).map((p) => p.subdomain as string);
}

/** The workspace federation config (policy, effective ceiling, peers, capability). */
export function fetchFederationConfig(): Promise<FederationConfig> {
  return reqJson<FederationConfig>('/api/federation/config');
}

/** Set the workspace policy (admin only; server enforces). */
export function setFederationPolicy(policy: FederationPolicy): Promise<{ policy: FederationPolicy }> {
  return reqJson('/api/federation/policy', {
    method: 'PATCH',
    body: JSON.stringify({ policy }),
  });
}

/** Add an allow- or deny-list peer (admin only). `listType` defaults to `allow`. */
export function addFederationPeer(input: {
  base_url: string;
  subdomain?: string;
  label?: string;
  listType?: PeerListType;
}): Promise<{ peer: FederationPeer }> {
  const { listType, ...rest } = input;
  return reqJson('/api/federation/peers', {
    method: 'POST',
    body: JSON.stringify({ ...rest, list_type: listType ?? 'allow' }),
  });
}

/** Remove an allow- or deny-list peer (admin only). */
export function removeFederationPeer(id: string): Promise<{ ok: true }> {
  return reqJson(`/api/federation/peers/${id}`, { method: 'DELETE' });
}

/** This workspace's federation links (with granted-root titles). */
export function fetchFederationLinks(): Promise<{ links: FederationLinkView[] }> {
  return reqJson('/api/federation/links');
}

/** A same-host, mutually-whitelisted peer's user roster for the share picker. 403 for a
 *  non-mutual/unknown peer; 501 for a cross-server (dotted) peer. The server enforces
 *  the mutual-whitelist gate — this is only a convenience for populating the picker. */
export function fetchDirectory(peer: string): Promise<{ users: FederationDirectoryUser[] }> {
  return reqJson(`/api/federation/directory?peer=${encodeURIComponent(peer)}`);
}

/** Whether `peer` is a live same-host tenant and mutually whitelisted (so its roster is
 *  fetchable). Used to decide whether the in-dialog picker is offer-able for this peer. */
export function fetchPeerStatus(peer: string): Promise<{ mutual: boolean; sameHost: boolean }> {
  return reqJson(`/api/federation/peer-status?peer=${encodeURIComponent(peer)}`);
}

/** Revoke a link (admin only; stops the exchange loop). */
export function revokeFederationLink(id: string): Promise<{ ok: true; status: string }> {
  return reqJson(`/api/federation/links/${id}/revoke`, { method: 'POST' });
}

/** Send a federation offer to `username@subdomain` for one of the caller's own roots.
 *  Reuses the existing `POST /api/federation/offers` (session + gates). */
export function sendFederationOffer(input: {
  to: string;
  root_item_id: string;
  permission: Permission;
}): Promise<{ link_id: string; status: string; permission: Permission }> {
  return reqJson('/api/federation/offers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
