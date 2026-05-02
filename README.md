# codex-telegram-bot

Unofficial local Telegram bridge for Codex app-server.

Local Telegram bridge for operating Codex chats through a local `codex app-server`.

## Startup

Run both `codex app-server` and the Telegram bot with the cross-platform supervisor:

```sh
npm install
cp .env.example .env
npm run service
```

On Windows PowerShell, create `.env` with:

```powershell
Copy-Item .env.example .env
```

The supervisor starts `codex app-server --listen <CODEX_WS_URL>` and then starts the bot according to `BOT_RUN_MODE`. This is the normal entrypoint; do not start a second app-server for the same bot session.

Use `BOT_RUN_MODE=DEV` to run the bot with `npm run dev`.

Use `BOT_RUN_MODE=PROD` to run `npm run build`, then start the bot with `npm start`.

## Telegram Setup

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_OWNER_ID=<TELEGRAM_OWNER_ID>
CODEX_WS_URL=ws://127.0.0.1:18765
CODEX_GLOBAL_STATE_PATH=<CODEX_GLOBAL_STATE_PATH>
PROJECTS_ROOT=<PROJECTS_ROOT>
PROMPT_CONFIG_DIR=prompt-configs
LOG_LEVEL=info
BOT_RUN_MODE=DEV
```

`.env` is local-only and must not be committed. Keep real Telegram tokens out of documentation, fixtures, logs, and git history.

Only Telegram user id `<TELEGRAM_OWNER_ID>` is accepted. The MVP rejects group and supergroup chats even for the owner.

## Commands

The Telegram command menu is dynamic. On startup the bot registers base commands globally and resets the owner private-chat scope to base commands. When Telegram polling starts, the owner private chat receives a startup notification with a `Выбрать проект` button that opens the same project picker as `/select_project`. After the owner selects a project, the owner chat menu is updated with project commands. Hidden commands can still be typed manually; handlers keep validating state and fail closed. Non-owner chats may see Telegram's global base menu, but access checks reject them before any Codex call.

Base menu before a project is selected:

- `/start` - show access result and help.
- `/help` - show available commands.
- `/status` - show the Codex app-server WebSocket connection status and URL.
- `/limits` - show current Codex limit remaining.
- `/select_project` - choose a safe direct project directory under `<PROJECTS_ROOT>`, then choose whether to create a new chat or select an existing project chat.
- `/reboot` - restart Codex app-server and the bot through the supervisor.

Project commands shown after a project is selected:

- `/select_chat` - list existing Codex chats for the selected project.
- `/new_chat` - create another Codex chat in the selected project.
- `/delete_chat` - delete a chat from the selected project by archiving it in Codex.
- `/current` - show the selected chat, model/context, and project.
- `/summary_chat` - ask Codex to summarize the selected chat.
- `/review_fix` - ask Codex to review current project or chat work, fix valid issues, and verify.

Always supported:

- `?` or `/` - text shortcuts that show available commands.
- Plain text - send a prompt to the selected Codex chat.

Telegram clients may cache command menus briefly; command handlers are the source of truth.

## Prompt Configs

Prompt-backed commands load editable prompt configs from `PROMPT_CONFIG_DIR`. The default value is `prompt-configs`, which is local-only and ignored by git.

The bot creates missing built-in default prompt files on first use. Users can edit `prompt-configs/review_fix.json` or add additional prompt configs without changing tracked source files.

`/review_fix` depends on the context available to Codex in the selected thread. The Telegram bridge does not directly read full chat history or git diffs through `codex app-server`; the prompt asks Codex to inspect available project changes or visible chat artifacts and to report clearly when more context is needed.

## Safety Notes

- Projectless Desktop chats are not exposed in Telegram.
- The bot never writes Codex Desktop global state.
- Project creation only accepts direct, readable, non-hidden, non-system, non-reparse directories under `<PROJECTS_ROOT>`.
- `/delete_chat` archives a Codex thread with `thread/archive`; it does not physically delete session/history files.
- Approval requests fail closed. Telegram approve/reject buttons are intentionally disabled until exact app-server approval protocol shapes are captured.
- `/review_fix` may edit project files only when Codex can identify reviewable project changes and the local environment permits the required tools. If approval is required, the existing fail-closed approval behavior applies.
- If `codex app-server` disconnects during an active turn, the bot sends a failure notice after a short grace period and does not resend the prompt automatically.
- The supervisor sends owner-only Telegram notices when the `codex app-server` or bot child process exits unexpectedly.
- Logs redact bot tokens, authorization headers, raw Telegram updates, raw Codex protocol events, and raw approval payloads by default.
- Keep the old Telegram notification bridge disabled while this bot owns the same Telegram bot/chat.
- Local runtime artifacts such as `.env`, `dist/`, `logs/`, `.tmp/`, and `node_modules/` are ignored by git.

## Failure Handling

When the owner sends a prompt, the bot first asks the app-server to start the turn. After the turn is accepted, Telegram receives `Codex is working...`; if turn startup fails, Telegram receives a retryable start failure instead.
If the app-server WebSocket disconnects before the turn completes while the bot process remains alive, the bot keeps the prompt fail-safe: it clears the local busy state, sends a no-resend failure notice to Telegram, and waits for the owner to retry manually.

The WebSocket client also uses ping/pong heartbeat as a fallback for stale connections. The supervisor separately sends an owner-only notice if the `codex app-server` or Telegram bot child process exits; this is intentionally independent from the bot's in-turn failure notice.

## Manual Acceptance

Latest manual Telegram acceptance for `/delete_chat` was confirmed by the owner on 2026-05-02.
Manual Telegram acceptance for the two-button `/select_project` UX was confirmed by the owner on 2026-05-02.
Manual Telegram acceptance for the startup notification and `Выбрать проект` button was confirmed by the owner on 2026-05-03.

1. Start `npm run service`; verify the owner private chat receives `Codex Telegram bridge started.` with a `Выбрать проект` button.
2. In Telegram as user `<TELEGRAM_OWNER_ID>`, run `/status`.
3. Run `/reboot`; verify both Codex app-server and the bot restart.
4. Run `/limits`; verify current Codex limit remaining is shown or a clear retryable error is returned.
5. Before selecting a project, run `/help` or type `/`; verify `/select_chat`, `/new_chat`, `/delete_chat`, `/current`, `/summary_chat`, and `/review_fix` are not shown.
6. Manually run `/current`, `/summary_chat`, `/review_fix`, `/select_chat`, `/new_chat`, and `/delete_chat` before selecting a project; verify each rejects without starting a Codex turn and directs you to `/select_project` where appropriate.
7. Run `/select_project`; verify only safe immediate directories under `<PROJECTS_ROOT>` are listed.
8. Pick any listed safe direct child directory under `<PROJECTS_ROOT>`; verify Telegram shows `Создать новый чат` and `Выбрать чат`, without creating a chat yet, and project commands appear in `/help` or the Telegram command menu.
9. Press `Выбрать чат`; verify only chats for the selected project are listed, or a clear no-chats message is shown.
10. Press `Создать новый чат` or run `/new_chat`; verify a new chat is created in the same selected project, becomes selected, and project commands remain visible.
11. Run `/delete_chat`; select a non-current chat, press `No`, and verify no chat is archived.
12. Run `/delete_chat`; select a non-current chat, press `Yes, delete`, and verify it disappears from `/select_chat` while the current chat remains selected.
13. Run `/delete_chat`; select the current chat, press `Yes, delete`, and verify a replacement chat is created in the same project and selected.
14. Run `/current`; verify context usage is shown, or a clear not-available fallback.
15. Run `/summary_chat`; verify Codex starts a summary turn in the selected chat, or rejects the request while the chat is busy.
16. Run `/review_fix`; verify Codex starts a review/fix turn in the selected chat, creates `prompt-configs/review_fix.json` if missing, or rejects the request while the chat is busy.
17. Send `ping`; verify the Codex response returns to Telegram.
18. Send a second message while Codex is answering; verify it is rejected.
19. Try a non-owner user and a group chat; verify no Codex call happens.
20. Ask for a long answer; verify Telegram replies are split into ordered chunks.
21. Run `/reboot`; after restart, verify the command menu returns to the base no-project commands until a project is selected again.
22. During an active turn, simulate a WebSocket connection loss while the bot remains alive; verify no duplicate prompt is sent, Telegram receives a clear failure notice, and `/status` reports reconnecting or disconnected.
23. Separately kill the supervisor-managed app-server; verify the supervisor sends an owner notice and stops the bot.
24. Trigger an approval-requiring Codex action if available; verify it fails closed and the owner gets a Telegram notice to continue in Codex Desktop or CLI.
25. Inspect logs; verify bot tokens, authorization headers, raw Telegram updates, raw Codex events, approval payloads, outgoing Telegram delivery payloads, and command-menu update failures are not printed with raw payload text.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```
