# mcp-blackbox

[![npm](https://img.shields.io/npm/v/@tirthlabs/mcp-blackbox?color=c2410c)](https://www.npmjs.com/package/@tirthlabs/mcp-blackbox) [![CI](https://github.com/tirthkparikh/mcp-blackbox/actions/workflows/ci.yml/badge.svg)](https://github.com/tirthkparikh/mcp-blackbox/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@tirthlabs/mcp-blackbox)](LICENSE) · [Live demo](https://tirthparikh.com/tools/mcp-blackbox/)

**A flight recorder for MCP servers.** Put it in front of any stdio MCP server to:

- **see every call** in a live web viewer: request, response, errors and timing
- **keep a log** of every session, with tokens, passwords and API keys hidden automatically
- **replay real sessions as tests**: re-send what a real client sent and fail CI if any answer changed

It works with any client (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf) and any stdio server, in any language, with no code changes. Messages pass through byte for byte.

```bash
npx @tirthlabs/mcp-blackbox --ui -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
```

## Why

When an agent "does something weird" with your MCP server, you usually can't see what it actually sent, what came back, or how long it took. The official Inspector is great for poking at a server by hand, but it isn't in the path when Claude or Cursor uses your server for real. mcp-blackbox is.

## Add it to a client

Put `npx -y @tirthlabs/mcp-blackbox --ui --` in front of the existing command.

**Claude Desktop / Cursor**

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@tirthlabs/mcp-blackbox", "--ui", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add my-server -- npx -y @tirthlabs/mcp-blackbox --ui -- python -m my_server
```

Open http://127.0.0.1:4300 to watch calls arrive live.

## Commands

```text
mcp-blackbox [--ui [port]] [--out file.jsonl] [--no-save] [--redact k1,k2] [--keep-large] -- <server command…>
mcp-blackbox ls                        recent sessions with call and error counts
mcp-blackbox view <file|latest>        open a recorded session in the viewer
mcp-blackbox stats <file|latest>       per-tool count, errors, p50 / p95 / max latency (--json)
mcp-blackbox replay <file|latest> [--ignore keys] [--timeout ms] -- <server command…>
```

Sessions are saved to `~/.mcp-blackbox/sessions/` (override with `MCP_BLACKBOX_DIR`) as JSON Lines, one message per line.

## Replay as regression tests

```bash
# 1. use your server normally through the recorder (or script a session)
npx @tirthlabs/mcp-blackbox --out tests/sessions/search.jsonl -- node dist/server.js

# 2. in CI: same requests against the new build, compare every response
npx @tirthlabs/mcp-blackbox replay tests/sessions/search.jsonl --ignore timestamp,requestId -- node dist/server.js
```

```text
✔ initialize                                  41ms (was 38ms)
✔ tools/list                                   3ms (was 3ms)
✖ tools/call search_orders                    12ms (was 15ms)
    result.content[0].text<json>.items[0].total: 120.5 → 120
4 passed, 1 failed
```

- JSON inside text content is compared field by field, so diffs point at the exact value.
- `--ignore` drops keys at any depth (`timestamp`), or exact paths (`result.content[].text`).
- Requests the server makes back to the client (roots, sampling) are answered from the recording.
- Hidden secrets and shortened large payloads are treated as matching.
- Values hidden in requests are sent as `[redacted]`. For sessions you plan to replay, pass test credentials through the server's environment, or record with `--redact` set to only what you need.
- Exit code is 1 on any difference.

## What gets hidden

Keys such as `password`, `token`, `secret`, `apiKey`, `authorization`, `cookie` and `private_key`, plus values that look like OpenAI, Anthropic, GitHub, Slack, AWS, Google, npm or Figma keys, JWTs, Bearer/Basic credentials and PEM private keys. Add your own keys with `--redact`. The client and server always see the real values; only the recording is cleaned.

## From code

```js
import { readSession, pairCalls, replay } from '@tirthlabs/mcp-blackbox';

const calls = pairCalls(await readSession('session.jsonl'));
const slow = calls.filter(c => c.ms > 1000);
```

## License

MIT © Tirth Parikh, [tirthparikh.com](https://tirthparikh.com)
