import { describe, it, expect } from "vitest";
import { summariseSession, type ChatSessionFile } from "../server.js";

function session(overrides: Partial<ChatSessionFile> = {}): ChatSessionFile {
  return {
    id: overrides.id ?? "11111111-2222-3333-4444-555555555555",
    messages: overrides.messages ?? [],
    themesConsulted: overrides.themesConsulted ?? [],
    createdAt: overrides.createdAt ?? "2026-05-01T10:00:00.000Z",
    lastActivity: overrides.lastActivity ?? "2026-05-01T10:00:00.000Z",
  };
}

describe("summariseSession", () => {
  it("uses 'New chat' when there are no user messages yet", () => {
    expect(summariseSession(session()).title).toBe("New chat");
    expect(
      summariseSession(
        session({ messages: [{ role: "assistant", content: "hello — how can I help?" }] })
      ).title
    ).toBe("New chat");
  });

  it("uses the first user message as the title", () => {
    const s = session({
      messages: [
        { role: "user", content: "What is the latest VDP status?" },
        { role: "assistant", content: "The VDP project is rolling back…" },
      ],
    });
    expect(summariseSession(s).title).toBe("What is the latest VDP status?");
  });

  it("truncates long titles to 60 chars with an ellipsis", () => {
    const longMsg =
      "I have a really really really really really really really really long question";
    const s = session({ messages: [{ role: "user", content: longMsg }] });
    const title = summariseSession(s).title;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses internal whitespace so multi-line first messages still produce a clean title", () => {
    const s = session({
      messages: [{ role: "user", content: "Hello\n\n   world\t\twith breaks" }],
    });
    expect(summariseSession(s).title).toBe("Hello world with breaks");
  });

  it("returns id, timestamps, and messageCount alongside the title", () => {
    const s = session({
      id: "abcdef01-2345-6789-abcd-ef0123456789",
      createdAt: "2026-05-01T10:00:00.000Z",
      lastActivity: "2026-05-02T15:30:00.000Z",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "follow-up" },
      ],
    });
    const m = summariseSession(s);
    expect(m.id).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    expect(m.createdAt).toBe("2026-05-01T10:00:00.000Z");
    expect(m.lastActivity).toBe("2026-05-02T15:30:00.000Z");
    expect(m.messageCount).toBe(3);
  });
});
