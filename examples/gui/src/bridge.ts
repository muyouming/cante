// HTTP client for the local Cante GUI bridge.
//
// PocketJS ships a bounded, whole-response `fetch` (`@pocketjs/framework/net`)
// and no sockets, so the GUI talks to `examples/gui/bridge/cante-bridge.ts`,
// which owns `cante serve` and re-exposes its event stream as a cursor-
// addressed long-poll.
import { fetch, NetError } from "@pocketjs/framework/net";

import type { EventsResponse } from "./protocol.ts";

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:4317";

/** Long-poll window; the bridge caps it at 25s and PocketJS's own cap is 120s. */
export const POLL_TIMEOUT_MS = 20_000;

export interface HealthResponse {
  ok: boolean;
  bridge: string;
  cante: string | null;
  cwd: string;
  daemon: boolean;
  status: string;
  stderr: string[];
}

export interface MutationResponse {
  ok: boolean;
  op?: string;
  error?: string;
}

/** The bridge is unreachable, or this host has no HTTP module at all. */
export class BridgeUnavailable extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "BridgeUnavailable";
  }
}

export interface Bridge {
  readonly base: string;
  health(timeoutMs?: number): Promise<HealthResponse>;
  events(cursor: number, timeoutMs?: number): Promise<EventsResponse>;
  get<T>(path: string, timeoutMs?: number): Promise<T>;
  post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
}

type HttpMethod = "GET" | "POST";

export function createBridge(base: string = DEFAULT_BRIDGE_URL): Bridge {
  const root = base.replace(/\/+$/, "");

  async function request<T>(path: string, init: { method: HttpMethod; body?: string }, timeoutMs: number): Promise<T> {
    let response;
    try {
      response = await fetch(`${root}${path}`, {
        method: init.method,
        headers: { "content-type": "application/json" },
        body: init.body,
        timeoutMs,
        maxBytes: 224 * 1024,
      });
    } catch (error) {
      const netError = error instanceof NetError ? error : null;
      throw new BridgeUnavailable(
        netError?.message ?? `bridge request failed: ${(error as Error).message}`,
        netError?.code ?? "network",
      );
    }
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 240);
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) detail = parsed.error;
      } catch {
        /* keep the raw body */
      }
      throw new Error(`${response.status} ${detail || response.url}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`bridge returned non-JSON for ${path}`);
    }
  }

  return {
    base: root,
    health(timeoutMs = 4_000) {
      return request<HealthResponse>("/healthz", { method: "GET" }, timeoutMs);
    },
    events(cursor, timeoutMs = POLL_TIMEOUT_MS) {
      return request<EventsResponse>(
        `/events?cursor=${cursor}&timeout_ms=${timeoutMs}`,
        { method: "GET" },
        timeoutMs + 5_000,
      );
    },
    get<T>(path: string, timeoutMs = 8_000) {
      return request<T>(path, { method: "GET" }, timeoutMs);
    },
    post<T>(path: string, body: unknown, timeoutMs = 8_000) {
      return request<T>(path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);
    },
  };
}
