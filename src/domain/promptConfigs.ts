import { z } from 'zod';

export const PROMPT_CONFIG_SCHEMA_VERSION = 1;

const promptTriggerSchema = z
  .string()
  .trim()
  .regex(/^\/[a-z0-9_]{1,64}$/, 'trigger must use lowercase letters, digits, or underscores');

const telegramMenuCommandSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,32}$/, 'telegram menu command must use lowercase letters, digits, or underscores');

export const promptConfigSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_CONFIG_SCHEMA_VERSION),
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, 'id must use lowercase letters, digits, underscores, or hyphens'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    triggers: z.array(promptTriggerSchema).min(1).max(20),
    telegramMenuCommand: telegramMenuCommandSchema.optional(),
    requiresSelectedChat: z.boolean(),
    workingMessage: z.string().trim().min(1).max(500),
    prompt: z.string().trim().min(1).max(30000),
    enabled: z.boolean()
  })
  .strict();

export type PromptConfig = z.infer<typeof promptConfigSchema>;

export type PromptConfigValidationIssue = {
  path: string;
  message: string;
};

export function promptConfigValidationIssues(error: z.ZodError): PromptConfigValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message
  }));
}
