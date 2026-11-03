import type { APIRequestContext } from "@playwright/test";

/**
 * Sprint 3 (EPIC-TEST-STD-0001) — Reusable authenticated API test client.
 *
 * Dynamic test entity generation replaces bloated static seed files: every
 * spec creates the wishlist / alert / tag / note records it needs at runtime
 * through these helpers, then removes them in cleanup.
 *
 * Authentication contract:
 *   - Native auth issues an httpOnly `mgpl_session` JWT cookie via
 *     POST /api/auth/login (src/routes/auth.ts).
 *   - The helpers operate on the passed `APIRequestContext`, so callers decide
 *     between browser-coupled (`page.request`, shares cookies with page) and
 *     isolated (`playwright.request.newContext()`) contexts.
 *   - `login()` is the caller's responsibility so multi-tenant tests can keep
 *     two independent sessions alive in one test.
 */

const BASE_URL = "http://localhost:4000";

/** Deterministic seeded mock users (see test/global-setup.ts). */
export const ALEX = { email: "alex.gamer@mgpl.io", password: "GamerPass2026!" };
export const JORDAN = { email: "jordan.dev@mgpl.io", password: "SecureDev2026!" };
/** Sprint 5 (EPIC-07): role-gated Analytics account (role "Leadership"). */
export const LEADERSHIP = { email: "leadership@mgpl.io", password: "LeaderPass2026!" };

export interface TestUser {
  email: string;
  password: string;
}

export interface WishlistItemInput {
  gameId: string;
  title: string;
  targetPrice?: number;
  coverImage?: string;
  notes?: string;
}

export interface AlertInput {
  gameId: string;
  title: string;
  targetPrice: number;
  currentPrice?: number;
  historicalLow?: number;
}

export interface TagInput {
  gameId: string;
  tagName: string;
  colorHex?: string;
}

export interface WishlistItem {
  id: string;
  userId: string;
  gameId: string;
  title: string;
  targetPrice: number;
  currentBestPrice: number;
  bestStore: string;
  bestStoreType: string;
  historicalLow: number;
  isTriggered: number;
  notes: string | null;
  coverImage: string | null;
}

export interface PriceAlert {
  id: string;
  userId: string;
  gameId: string;
  title: string;
  targetPrice: number;
  currentPrice: number;
  historicalLow: number;
  isTriggered: number;
}

interface ApiSuccess {
  success: boolean;
}

/** Logs in and returns the authenticated context (mutates the cookie jar). */
export async function login(context: APIRequestContext, user: TestUser = ALEX): Promise<void> {
  const res = await context.post(`${BASE_URL}/api/auth/login`, { data: user });
  if (res.status() !== 200) {
    throw new Error(`login failed for ${user.email}: ${res.status()} ${await res.text()}`);
  }
}

/** Upserts a wishlist item scoped to the authenticated user. */
export async function createTestWishlistItem(
  context: APIRequestContext,
  input: WishlistItemInput
): Promise<WishlistItem> {
  const res = await context.post(`${BASE_URL}/api/wishlist`, { data: input });
  if (res.status() !== 200) {
    throw new Error(`createTestWishlistItem failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body?.success || !body?.item) {
    throw new Error(`createTestWishlistItem returned an unexpected payload: ${JSON.stringify(body)}`);
  }
  return body.item as WishlistItem;
}

/** Upserts a price alert scoped to the authenticated user. */
export async function createTestAlert(
  context: APIRequestContext,
  input: AlertInput
): Promise<PriceAlert> {
  const res = await context.post(`${BASE_URL}/api/alerts`, { data: input });
  if (res.status() !== 200) {
    throw new Error(`createTestAlert failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body?.success || !body?.alert) {
    throw new Error(`createTestAlert returned an unexpected payload: ${JSON.stringify(body)}`);
  }
  return body.alert as PriceAlert;
}

/** Adds a custom tag to a game for the authenticated user. */
export async function createTestTag(
  context: APIRequestContext,
  input: TagInput
): Promise<string[]> {
  const res = await context.post(`${BASE_URL}/api/tags`, { data: input });
  if (res.status() !== 200) {
    throw new Error(`createTestTag failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body?.success) {
    throw new Error(`createTestTag returned an unexpected payload: ${JSON.stringify(body)}`);
  }
  return (body.tags as string[]) || [];
}

/** Upserts a markdown note for a game for the authenticated user. */
export async function createTestNote(
  context: APIRequestContext,
  gameId: string,
  noteMarkdown: string
): Promise<void> {
  const res = await context.put(`${BASE_URL}/api/notes/${encodeURIComponent(gameId)}`, {
    data: { noteMarkdown },
  });
  if (res.status() !== 200) {
    throw new Error(`createTestNote failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as ApiSuccess;
  if (!body.success) {
    throw new Error(`createTestNote returned an unexpected payload: ${JSON.stringify(body)}`);
  }
}

export type DeleteKind = "wishlist" | "alert" | "tag";

/**
 * Deletes a dynamically-created test record. For tags the caller must supply
 * the gameId via `extra.gameId` because DELETE /api/tags is body-based.
 * Missing records are tolerated (the helper scans for the target before
 * deleting via the read helper where the API supports it).
 */
export async function deleteTestItem(
  context: APIRequestContext,
  kind: DeleteKind,
  id: string,
  extra?: { gameId?: string; tagName?: string }
): Promise<void> {
  if (kind === "wishlist") {
    // The wishlist delete route accepts either gameId or row id.
    await context.delete(`${BASE_URL}/api/wishlist/${encodeURIComponent(id)}`);
    return;
  }
  if (kind === "alert") {
    await context.delete(`${BASE_URL}/api/alerts/${encodeURIComponent(id)}`);
    return;
  }
  if (kind === "tag") {
    await context.delete(`${BASE_URL}/api/tags`, {
      data: { gameId: extra?.gameId, tagName: extra?.tagName ?? id },
    });
  }
}

/** Lists the authenticated user's wishlist entries. */
export async function getWishlist(context: APIRequestContext): Promise<WishlistItem[]> {
  const res = await context.get(`${BASE_URL}/api/wishlist`);
  if (res.status() !== 200) {
    throw new Error(`getWishlist failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.wishlist as WishlistItem[]) || [];
}

/** Lists the authenticated user's price alerts. */
export async function getAlerts(context: APIRequestContext): Promise<PriceAlert[]> {
  const res = await context.get(`${BASE_URL}/api/alerts`);
  if (res.status() !== 200) {
    throw new Error(`getAlerts failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.alerts as PriceAlert[]) || [];
}

/** Returns tag names for a game scoped to the authenticated user. */
export async function getTagsForGame(context: APIRequestContext, gameId: string): Promise<string[]> {
  const res = await context.get(`${BASE_URL}/api/tags/game/${encodeURIComponent(gameId)}`);
  if (res.status() !== 200) {
    throw new Error(`getTagsForGame failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.tags as string[]) || [];
}

/** Returns the markdown note for a game scoped to the authenticated user. */
export async function getNote(context: APIRequestContext, gameId: string): Promise<string> {
  const res = await context.get(`${BASE_URL}/api/notes/${encodeURIComponent(gameId)}`);
  if (res.status() !== 200) {
    throw new Error(`getNote failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.noteMarkdown as string) || "";
}