import { afterEach, describe, expect, test } from "bun:test";
import observability from "./pi-observability.ts";

type Handler = (event: any, ctx: any) => unknown;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockPi() {
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ type: string; data: any }> = [];
  const pi = {
    version: "test",
    registerFlag() {},
    getFlag() { return undefined; },
    getSessionName() { return "reload regression"; },
    appendEntry(type: string, data: any) { entries.push({ type, data }); },
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  return {
    pi,
    entries,
    async emit(name: string, event: any, ctx: any) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function assertCollisionDiagnostic(entries: Array<{ type: string; data: any }>) {
  expect(entries.some((entry) =>
    entry.type === "obs-log" &&
    entry.data?.message === "post_failed" &&
    String(entry.data?.error ?? "").includes("sequence collision")
  )).toBe(true);
}

function context(sessionId: string) {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "test-model" },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionName: () => "reload regression",
    },
    ui: { notify() {} },
  };
}

describe("OBS sequence continuity", () => {
  test("reports receiver sequence collisions instead of silently accepting the 2xx", async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/events")) {
        return Response.json({ ingested: 0, rejected: ["collision"], collisions: ["collision"] });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    const generation = mockPi();
    const ctx = context("collision-diagnostic");
    observability(generation.pi as any);
    await generation.emit("session_start", { reason: "startup" }, ctx);
    await generation.emit("session_shutdown", { reason: "exit" }, ctx);

    assertCollisionDiagnostic(generation.entries);
  });

  test("a same-session extension generation after reload cannot reuse sequence numbers", async () => {
    const posted: any[][] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/events")) {
        posted.push(JSON.parse(String(init?.body ?? "[]")));
        return Response.json({ ingested: 1, rejected: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    const sessionId = "same-session-after-reload";
    const ctx = context(sessionId);

    const first = mockPi();
    observability(first.pi as any);
    await first.emit("session_start", { reason: "startup" }, ctx);
    await first.emit("before_agent_start", { prompt: "first" }, ctx);
    await first.emit("session_shutdown", { reason: "reload" }, ctx);

    const second = mockPi();
    observability(second.pi as any);
    await second.emit("session_start", { reason: "reload" }, ctx);
    await second.emit("before_agent_start", { prompt: "second" }, ctx);
    await second.emit("session_shutdown", { reason: "exit" }, ctx);

    expect(posted).toHaveLength(2);
    // A reload is not an end (obs-console#99): the first generation flushes
    // its pending events but emits no session_shutdown closure.
    expect(posted[0].map((event) => event.type)).toEqual(["session_start", "agent_start"]);
    const firstSeq = posted[0].map((event) => event.seq);
    const secondSeq = posted[1].map((event) => event.seq);
    expect(Math.min(...secondSeq)).toBeGreaterThan(Math.max(...firstSeq));
  });

  test("a reload emits no session_shutdown while a real exit still does", async () => {
    const posted: any[][] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/events")) {
        posted.push(JSON.parse(String(init?.body ?? "[]")));
        return Response.json({ ingested: 1, rejected: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    const sessionId = "reload-no-closure";
    const ctx = context(sessionId);

    const generation = mockPi();
    observability(generation.pi as any);
    await generation.emit("session_start", { reason: "startup" }, ctx);
    await generation.emit("before_agent_start", { prompt: "work" }, ctx);
    await generation.emit("session_shutdown", { reason: "reload" }, ctx);
    const afterReload = posted.flat().filter((event) => event.type === "session_shutdown");
    expect(afterReload).toEqual([]);

    // The same generation keeps serving; a later real exit still closes.
    await generation.emit("before_agent_start", { prompt: "more work" }, ctx);
    await generation.emit("session_shutdown", { reason: "quit" }, ctx);
    const exits = posted.flat().filter((event) => event.type === "session_shutdown");
    expect(exits).toHaveLength(1);
    expect(exits[0].payload.reason).toBe("quit");
  });
});
