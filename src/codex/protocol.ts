export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;

export type CodexThread = {
  id: string;
  preview?: string | null;
  path?: string | null;
  cwd?: string | null;
  name?: string | null;
  updatedAt?: number;
  status?: unknown;
  [key: string]: unknown;
};

export type CodexTurn = {
  id: string;
  status?: string;
  error?: unknown;
  [key: string]: unknown;
};

export type ThreadListResponse = {
  data: CodexThread[];
};

export type ThreadStartResponse = {
  thread: CodexThread;
};

export type ThreadResumeResponse = {
  thread: CodexThread;
};

export type ThreadArchiveResponse = Record<string, never>;

export type TurnStartResponse = {
  turn: CodexTurn;
};

export type AgentMessageDeltaNotification = {
  threadId: string;
  turnId: string;
  itemId?: string;
  delta: string;
};

export type TurnCompletedNotification = {
  threadId: string;
  turn: CodexTurn;
};

export type ServerRequest = {
  id: number | string;
  method: string;
  params?: JsonValue;
  threadId?: string;
  turnId?: string;
};
