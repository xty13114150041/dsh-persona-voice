# dsh-persona-voice

[中文](README.md) | English

A persona relay plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The working agent focuses on the task. After each turn, a second, context-carrying "persona agent" rewrites the final answer in the character voice you define. The chat shows the persona version, and the original answer is folded into the reasoning section so you can always check it.

## What you get

- When enabled, the working agent's answer is folded into the process chain right away (no flash of the original); the process shows "正在组织语言…" (organizing words) and the persona version appears a few seconds later.
- The persona agent's history is append-only with the persona fixed in the system prompt, trimmed in large batches, so most turns reuse the same cached prefix. A short fixed reminder is appended to every user message (kept identical so cached prefixes stay valid). Actual token usage (including cache hits) is logged to `debug.log`.
- A "查看原文" (show original) button under the answer toggles between the persona version and the original; the original is also kept in the reasoning block as "【执行原文】".
- Only each turn's final answer is rewritten. Tool calls, intermediate steps and subagents stay untouched.
- The persona agent keeps its own multi-turn history: your messages, the working agent's raw output, and its own replies. It remembers the conversation and varies its phrasing.

## How it works

- The host side listens to `agent/turn-stopping` and makes one separate model call in the background. The call has no tools and does not enter the working agent's context.
- The browser side wraps the official assistant-message renderer and replaces only the final answer's blocks. Markdown is still rendered by the official component.
- The default relay rules tell the persona agent to relay only, never propose new actions, and keep code, paths, numbers and errors verbatim.

## Install

Source install only for now. Clone the repo, then edit `package.json` in your DSH profile directory (desktop: `~/.dsh/profiles/desktop`):

- add `"@local/dsh-persona-voice"` to `dsh.profile.bundles`
- add `"@local/dsh-persona-voice": "link:/path/to/dsh-persona-voice"` to `dependencies`

Then run `pnpm install` there and restart DSH. Back up `package.json` and `pnpm-lock.yaml` first.

## Settings

Open **Settings → 人设转述 (Persona voice)**. Changes apply from the next turn, with no restart needed.

You can set:

- an on/off switch (off by default)
- the model to use (defaults to the session's model; same list as the composer picker)
- the reasoning effort (auto = off or the lowest level by default)
- an optional persona file, re-read every turn; if it contains a `<xxx_persona>…</xxx_persona>` block, only that block is used
- the persona text, used when no file is set
- the relay rules
- a short per-turn reminder
- context-length limits

Data lives in `~/.dsh/persona-voice/`: `settings.json`, one JSON file per session, and `debug.log`.

## Caveats

- One extra model call per turn, so extra token cost.
- The rewrite can introduce mistakes. Expand the original output for anything important.
- Copy and quote actions still use the original text.
- The working agent never sees the persona version.
- The renderer wrapping relies on DSH internals and may break on DSH upgrades; if it does, the original answer is shown.
- Tested on DSH Desktop 0.2.2-rc.1 (macOS).

## License

MIT
