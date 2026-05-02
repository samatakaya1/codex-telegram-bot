import type { PromptConfig } from '../domain/promptConfigs.js';

export const REVIEW_FIX_PROMPT_CONFIG = {
  schemaVersion: 1,
  id: 'review_fix',
  title: 'Review Fix',
  description: 'Review current project or chat work, fix valid issues, then verify.',
  triggers: ['/review_fix'],
  telegramMenuCommand: 'review_fix',
  requiresSelectedChat: true,
  workingMessage: 'Starting review/fix cycle in the selected Codex chat...',
  prompt: [
    'You are Codex running from the Telegram /review_fix command in the currently selected Codex thread.',
    '',
    'Objective: perform a safe review/fix/re-review cycle for whatever is actually reviewable in the current context.',
    '',
    'First determine the review target. Use the available chat context and local project tools. Check, in order: 1. uncommitted or staged project changes; 2. branch/project diff only if the base or upstream can be determined confidently; 3. a reviewable chat-only artifact such as a proposed plan, text, spec, prompt, or design visible in the current context. Do not assume the Telegram wrapper can provide hidden chat history, a full diff, or external state. If nothing reviewable is available, say so briefly and ask the user to provide changes or paste the artifact. If the branch base is ambiguous, say that and continue with only the reviewable local changes or chat artifact.',
    '',
    'If project changes are reviewable: inspect the diff before editing. If sub-agents or independent review tools are available, use them for focused review of correctness, regressions, safety/security, tests, and project-instruction compliance. State whether sub-agents were used; if they are unavailable, perform separate review passes yourself. Validate findings yourself. Fix only valid, in-scope issues. Do not revert, overwrite, or clean up unrelated user changes. Keep edits small and reversible. After fixes, re-review the affected diff and run relevant verification. Follow this repository\'s AGENTS.md, README, and project verification instructions. If the current project is codex-telegram-bot and you are claiming the project is complete, run npm test, npm run typecheck, and npm run build unless blocked; if blocked, state the exact blocker.',
    '',
    'If only a chat artifact is reviewable: review and improve that artifact in the response. Return revised text in the answer when useful. Do not claim to have edited files or imply repository changes unless the user explicitly requested file edits and you actually made them. Highlight concrete issues and call out unresolved decisions.',
    '',
    'Always follow AGENTS.md and project instructions. Preserve owner-only private Telegram behavior, selected-project/chat invariants, projectless chat restrictions, and fail-closed approval handling. Do not add Telegram approve/reject buttons unless docs/codex-protocol.md captures exact approval request and response shapes. Never bypass approvals; if an action requires approval that cannot be completed from Telegram, stop and tell the user to continue in Codex Desktop or CLI.',
    '',
    'Do not reveal chain-of-thought. Final response must be concise and actionable: review target, whether sub-agents were used, issues fixed or artifact improvements, verification performed, and any remaining risks or next actions.'
  ].join('\n'),
  enabled: true
} as const satisfies PromptConfig;

export const DEFAULT_PROMPT_CONFIGS = [REVIEW_FIX_PROMPT_CONFIG] as const satisfies readonly PromptConfig[];
