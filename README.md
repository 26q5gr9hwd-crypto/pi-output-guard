# pi-output-guard

Universal token ceiling for [`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) tool results.

## Why

pi-ai extensions like `pi-context-saver` hook a hardcoded list of tools (bash, read, grep, ...). Any new tool — MCP, custom, subagent — bypasses them. A single 389 k-token `context_log` tool_result can blow the context window in one turn.

`pi-output-guard` hooks the universal `tool_result` event and caps **every** tool result at a configurable token ceiling (default **10 000 tokens**). When a result exceeds the ceiling, the full output is spilled to `/tmp/pi-output-guard/` and the LLM sees a `head` + `tail` + notice with the file path.

## Install

```bash
pi install git:https://github.com/26q5gr9hwd-crypto/pi-output-guard
```

## Usage

Once installed, it runs automatically. When a tool returns a large result you'll see:

```
[pi-output-guard] Tool result from "bash" exceeded 10000 tokens.
Original size: ~38000 tokens. Showing head+tail (~4000 tokens).
Full output saved to: /tmp/pi-output-guard/bash-<session>-<ts>.txt
To retrieve specific sections, call the "output_read" tool with:
  { "path": "...", "offset_lines": <start>, "limit_lines": <count> }
```

The LLM can then call the `output_read` tool to pull specific sections.

## Commands

- `/output-guard stats` — show session stats
- `/output-guard threshold <N>` — set global threshold (tokens)
- `/output-guard enable` / `/output-guard disable`
- `/output-guard doctor` — diagnose paths, estimator, config

## Config

`~/.pi/agent/pi-output-guard.json`:

```json
{
  "enabled": true,
  "threshold": 10000,
  "headTokens": 2000,
  "tailTokens": 2000,
  "perTool": { "bash": 20000 }
}
```

Stats: `~/.pi/agent/pi-output-guard/stats.json`

## Safety

- Mutation only on the in-flight `tool_result` content delivered to the LLM.
- The persisted session JSONL is never touched.
- Rollback: `pi uninstall pi-output-guard`. No persistent state outside the stats file.

## License

MIT
