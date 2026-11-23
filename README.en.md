# dsh-persona-voice

[中文](README.md) | English

A persona relay plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The working agent focuses on the task. After each turn, a second, context-carrying "persona agent" rewrites the final answer in the character voice you define. The chat shows the persona version, and the original answer is folded into the reasoning section so you can always check it.

## What you get

- When enabled, the working agent's answer is folded into the process chain right away (no flash of the original); the process shows "正在组织语言…" (organizing words) and the persona version appears a few seconds later.
- The persona stays fixed in the system prompt. All-turn mode appends saved history; last-five mode uses a rolling window. A short fixed reminder is appended to every user message. Actual token usage (including cache hits) is logged to `debug.log`.
- A "查看原文" (show original) button under the answer toggles between the persona version and the original; the original is also kept in the reasoning block as "【执行原文】".
- Only each turn's final answer is rewritten. Tool calls, intermediate steps and subagents stay untouched.
- The persona agent keeps its own multi-turn history: your messages, the working agent's raw output, and its own replies. It remembers the conversation and varies its phrasing.

## How it works

- The host snapshots the turn at `agent/turn-stopping` before queueing the relay call. Automatic continuations without a new human message do not reuse the previous question. The relay call has no tools and does not enter the working agent's context.
- The browser side wraps the official assistant-message renderer and replaces only the final answer's blocks. Markdown is still rendered by the official component.
- The default relay rules tell the persona agent to relay only, never propose new actions, and keep code, paths, numbers and errors verbatim.

## Install

**Desktop:** Open **Plugins → Add plugin** and paste the [GitHub Release package](https://github.com/xty13114150041/dsh-persona-voice/releases/download/v0.6.0/dsh-persona-voice.tgz) URL, or download the `.tgz` and select it as a local package.

**Web / CLI:**

```bash
dsh plugin --profile web add https://github.com/xty13114150041/dsh-persona-voice/releases/download/v0.6.0/dsh-persona-voice.tgz
```

Replace `web` with your profile name if needed. The package ships runnable JavaScript and needs no build or lifecycle-script approval. Refresh or restart as directed by DSH. Relay is off by default; set a persona and enable it under **Settings → Persona relay**. If the same profile already has a locally linked checkout, remove that link before installing the release. Settings and history are retained.

Uninstall via the DSH Plugins page or `dsh plugin --profile web remove @local/dsh-persona-voice`. This leaves the local data intact.

## Settings

Open **Settings → Persona relay**. Changes apply from the next turn, with no restart needed.

You can set:

- an on/off switch (off by default)
- the model to use (defaults to the session's model; same list as the composer picker)
- the reasoning effort (auto = off or the lowest level by default)
- persona presets: save several personas and switch between them with a dropdown (the selected one is in use). Each preset has:
  - an optional persona file, re-read every turn; if it contains a `<xxx_persona>…</xxx_persona>` block, only that block is used
  - the persona text, used when no file is set
- the relay rules
- a short per-turn reminder
- relay context: current turn only, last five turns including the current turn, or all saved relay history in this conversation. New setups default to the last five turns; existing limits stay in effect until a new scope is selected.
- output length limit

**Relay cost estimate** shows today's usage (host time zone) and the total from the local log, only for the extra relay calls. Under **Model rates**, choose a provider and model, select the currency, enter the per-million-token rates, and save them separately. Use 0 for free or inapplicable categories. Calls without rates or reported usage are not priced. Rate changes reprice the retained history; currencies are shown separately. Even estimates based on official API list prices are not a provider bill.

Relay rules, the per-turn reminder, and the output limit are under **Advanced settings**.

## Data and privacy

When enabled, the plugin uses a model provider already configured in DSH. The selected model receives the persona, the current turn’s user text and final assistant answer, and the relay history allowed by your context setting. If you select a persona file, the DSH host reads it and sends the portion used as the persona. Keep secrets and anything you do not want to share with that provider out of the persona and conversation. The plugin does not ask for a separate API key.

Data lives in `$DSH_HOME/persona-voice/` (default `~/.dsh/persona-voice/`): `settings.json`, `rates.json` (manual model rates), one JSON file per session, and `debug.log`. Disabling the plugin does not delete that data.

## Caveats

- One extra model call per turn, so extra token cost. In long conversations, all-turn mode can cost more or exceed the model’s context limit.
- The rewrite can introduce mistakes. Expand the original output for anything important.
- Copy and quote actions still use the original text.
- The working agent never sees the persona version.
- The renderer wrapping relies on DSH internals and may break on DSH upgrades; if it does, the original answer is shown.
- The bundle declares DSH `^0.2.2-rc.2`. An earlier plugin version was tested on DSH Desktop 0.2.2-rc.3 (macOS). For 0.6.0, installation, the settings API, delivery of the browser module, and uninstall were verified in an isolated DSH Web 0.2.2-rc.5 profile. The Desktop UI was not retested.

## License

MIT
