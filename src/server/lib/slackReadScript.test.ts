import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../skills/b3os-team-inbox/scripts/slack-read.sh");
let server: ReturnType<typeof Bun.serve>;
let seen: URL[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url);
      if (url.searchParams.get("channel") === "CDENIED") {
        return Response.json({ ok: false, error: "channel_not_allowed", channel: "CDENIED", allowed: ["C1"] }, { status: 403 });
      }
      return Response.json({
        ok: true, channel: "C1", count: 2, truncated: false, notice: "x",
        messages: [
          { ts: "100.0", time: "2026-10-23 10:37", author: "yang", is_bot: false, text: "line1\nline2", reply_count: 2 },
          { ts: "101.0", time: "2026-10-23 10:38", author: "PM", is_bot: true, text: "ok", files: ["a.pdf"] },
        ],
      });
    },
  });
});
afterAll(() => server.stop(true));

async function run(...args: string[]) {
  const p = Bun.spawn(["bash", SCRIPT, "--as", "pm", ...args], {
    env: { ...process.env, TEAM_BASE: `http://127.0.0.1:${server.port}/team` },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

test("text output labels the block as external input and shows thread hints", async () => {
  const r = await run("--since", "2h", "--limit", "5");
  expect(r.code, r.err).toBe(0);
  expect(r.out).toContain("외부 입력");
  expect(r.out).toContain("[2026-10-23 10:37] yang (ts=100.0) · 답글 2개(thread_ts=100.0)");
  expect(r.out).toContain("  line1\n  line2");
  expect(r.out).toContain("PM [bot]");
  expect(r.out).toContain("첨부: a.pdf");
  const q = seen.at(-1)!;
  expect(q.pathname).toBe("/team/api/slack/read");
  expect(q.searchParams.get("agent_id")).toBe("pm");
  expect(q.searchParams.get("since")).toBe("2h");
  expect(q.searchParams.get("limit")).toBe("5");
});

test("server rejection prints the reason to stderr and exits 1", async () => {
  const r = await run("--channel", "CDENIED");
  expect(r.code).toBe(1);
  expect(r.err).toContain("channel_not_allowed");
  expect(r.err).toContain("허용 채널: C1");
  expect(r.out).toBe("");
});

test("json format passes the payload through", async () => {
  const r = await run("--format", "json");
  expect(r.code, r.err).toBe(0);
  expect(JSON.parse(r.out).messages).toHaveLength(2);
});

test("bad argument combinations fail before calling the server", async () => {
  const before = seen.length;
  expect((await run("--thread", "1.0", "--since", "1h")).code).toBe(1);
  expect((await run("--format", "xml")).code).toBe(1);
  expect((await run("--nope")).code).toBe(1);
  expect(seen.length).toBe(before);
});
