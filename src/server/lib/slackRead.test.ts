import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import { capTotal, formatSlackText, parseSince, readSlackChannel, type SlackRawResponse, type SlackReadFetch } from "./slackRead";
import type { AgentRecord } from "../types";

const CREDS = { bot_token: "mock-only", signing_secret: null, app_id: null, app_token: null };
const AGENTS = [{ id: "pm", display_name: "PM", slack_bot_user_id: "UPM1" } as AgentRecord];
let db: Database;
let seen: { method: string; params: Record<string, string>; token: string }[];

function fetcher(res: SlackRawResponse): SlackReadFetch {
  return async (method, params, token) => { seen.push({ method, params, token }); return res; };
}
function setting(key: string, value: string) {
  db.run("INSERT INTO setting (key, value) VALUES (?, ?)", [key, value]);
}
function read(extra: Partial<Parameters<typeof readSlackChannel>[0]> = {}) {
  return readSlackChannel({ db, agents: AGENTS, agentId: "pm", creds: CREDS, ...extra });
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  seen = [];
});

describe("readSlackChannel guards", () => {
  test("agent without Slack creds is 404", async () => {
    setting("slack_read_channels", "C1");
    const r = await read({ creds: null, fetcher: fetcher({ ok: true }) });
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test("no allowlist configured is 403 and never calls Slack", async () => {
    const r = await read({ channel: "C1", fetcher: fetcher({ ok: true }) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("no_read_channels_configured");
    expect(seen).toHaveLength(0);
  });

  test("channel outside the allowlist is 403 and never calls Slack", async () => {
    setting("slack_read_channels", "C1");
    const r = await read({ channel: "C2", fetcher: fetcher({ ok: true }) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("channel_not_allowed");
    expect(seen).toHaveLength(0);
  });

  test("malformed channel, thread_ts and since are 400", async () => {
    setting("slack_read_channels", "C1");
    expect((await read({ channel: "x y", fetcher: fetcher({ ok: true }) })).body.error).toBe("bad_channel");
    expect((await read({ channel: "C1", threadTs: "abc", fetcher: fetcher({ ok: true }) })).body.error).toBe("bad_thread_ts");
    expect((await read({ channel: "C1", since: "2weeks", fetcher: fetcher({ ok: true }) })).body.error).toBe("bad_since");
    expect(seen).toHaveLength(0);
  });

  test("Slack not_in_channel surfaces as 502 with an invite hint", async () => {
    setting("slack_read_channels", "C1");
    const r = await read({ fetcher: fetcher({ ok: false, error: "not_in_channel" }) });
    expect(r.status).toBe(502);
    expect(r.body.hint).toContain("/invite");
  });
});

describe("readSlackChannel history", () => {
  beforeEach(() => { setting("slack_read_channels", "C1,C9"); setting("slack_read_default_channel", "C1"); });

  test("uses the default channel, the agent's own token, and returns oldest first", async () => {
    const r = await read({ fetcher: fetcher({ ok: true, messages: [
      { ts: "200.0", user: "U1", text: "second" },
      { ts: "100.0", user: "UPM1", bot_id: "B1", text: "first <@UPM1>" },
    ] }) });
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "conversations.history", token: "mock-only" });
    expect(seen[0]!.params.channel).toBe("C1");
    const msgs = r.body.messages as { text: string; author: string; is_bot: boolean }[];
    expect(msgs.map((m) => m.text)).toEqual(["first @PM", "second"]);
    expect(msgs[0]).toMatchObject({ author: "PM", is_bot: true });
    expect(msgs[1]).toMatchObject({ author: "U1", is_bot: false });
  });

  test("clamps limit and converts since into oldest", async () => {
    await read({ limit: 9999, since: "2h", nowMs: 10_000_000 * 1000, fetcher: fetcher({ ok: true, messages: [] }) });
    expect(seen[0]!.params.limit).toBe("50");
    expect(Number(seen[0]!.params.oldest)).toBe(10_000_000 - 7200);
    await read({ limit: 0, fetcher: fetcher({ ok: true, messages: [] }) });
    expect(seen[1]!.params.limit).toBe("1");
  });

  test("thread read keeps the parent and the newest replies", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({ ts: `${100 + i}.0`, user: "U1", text: `m${i}` }));
    const r = await read({ threadTs: "100.0", limit: 3, fetcher: fetcher({ ok: true, messages }) });
    expect(seen[0]).toMatchObject({ method: "conversations.replies" });
    expect(seen[0]!.params.ts).toBe("100.0");
    expect((r.body.messages as { text: string }[]).map((m) => m.text)).toEqual(["m0", "m3", "m4"]);
  });

  test("join and leave notices are skipped", async () => {
    const r = await read({ fetcher: fetcher({ ok: true, messages: [
      { ts: "3.0", user: "U1", text: "bye", subtype: "channel_leave" },
      { ts: "2.0", user: "U1", text: "real" },
      { ts: "1.0", user: "U1", text: "joined", subtype: "channel_join" },
    ] }) });
    expect((r.body.messages as { text: string }[]).map((m) => m.text)).toEqual(["real"]);
    expect(r.body.count).toBe(1);
  });

  test("an audit-safe body never contains the token", async () => {
    const r = await read({ fetcher: fetcher({ ok: true, messages: [{ ts: "1.0", user: "U1", text: "hi" }] }) });
    expect(JSON.stringify(r.body)).not.toContain("mock-only");
  });
});

describe("helpers", () => {
  test("parseSince accepts m/h/d and rejects zero, junk and over 30d", () => {
    expect(parseSince("30m")).toBe(1800);
    expect(parseSince("2h")).toBe(7200);
    expect(parseSince("7d")).toBe(604800);
    expect(parseSince("0h")).toBeNull();
    expect(parseSince("31d")).toBeNull();
    expect(parseSince("soon")).toBeNull();
  });

  test("formatSlackText resolves mentions, links and entities", () => {
    const names = new Map([["UPM1", "PM"]]);
    expect(formatSlackText("hi <@UPM1> <@U9> see <https://x.test/a|doc> &amp; <#C1|general> <!here>", names))
      .toBe("hi @PM @U9 see doc (https://x.test/a) & #general @here");
  });

  test("capTotal drops the oldest messages first and flags truncation", () => {
    const msg = (i: number) => ({ ts: `${i}.0`, time: "", author: "a", is_bot: false, text: "x".repeat(1900) });
    const r = capTotal([msg(1), msg(2), msg(3), msg(4), msg(5)]);
    expect(r.truncated).toBe(true);
    expect(r.messages.at(-1)!.ts).toBe("5.0");
    expect(r.messages.length).toBeLessThan(5);
  });
});
