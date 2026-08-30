import { describe, expect, test } from "bun:test";
import { detectSessionHost } from "./pi-observability.ts";

// obs-console #119 registry contract: first match wins, orca before tmux.
// Env-only matrices — no subprocess needed because the tmux probe requires
// TMUX/TMUX_PANE to be set, which these cases avoid.
describe("detectSessionHost", () => {
  test("orca: valid handle wins over tmux env (outer addressable surface)", () => {
    const host = detectSessionHost({
      ORCA_TERMINAL_HANDLE: "term_95510387-ef44-4b23-99bb-fbfa3401574b",
      TMUX: "/tmp/tmux-501/default,123,0",
      TMUX_PANE: "%0",
    });
    expect(host).toEqual({
      type: "orca",
      terminalHandle: "term_95510387-ef44-4b23-99bb-fbfa3401574b",
    });
  });

  test("orca: absent env with tmux env falls through to tmux chain (probe fails cleanly outside tmux)", () => {
    const host = detectSessionHost({ TMUX: "/tmp/tmux-501/default,123,0" });
    // No TMUX_PANE -> tmux detection returns undefined without probing.
    expect(host).toBeUndefined();
  });

  test("orca: malformed handles are rejected, never guessed", () => {
    for (const handle of ["", "term_short", "not_a_handle", "term_XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"]) {
      expect(detectSessionHost({ ORCA_TERMINAL_HANDLE: handle })).toBeUndefined();
    }
  });

  test("neither host env present -> undefined (plain shell stays hostless)", () => {
    expect(detectSessionHost({})).toBeUndefined();
  });

  test("orca: 32-hex remote-runtime handle form is accepted", () => {
    const hex = "term_" + "a".repeat(32);
    expect(detectSessionHost({ ORCA_TERMINAL_HANDLE: hex })).toEqual({
      type: "orca",
      terminalHandle: hex,
    });
  });
});
