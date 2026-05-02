export type ActiveTurn = {
  turnId: string;
  threadId: string;
  telegramChatId: number;
  telegramMessageId?: number;
  selectedThreadId: string;
  accumulatedAssistantText: string;
  reply?: (text: string, options?: unknown) => Promise<void>;
};

export type StartTurnContext = Omit<ActiveTurn, 'accumulatedAssistantText'> & {
  accumulatedAssistantText?: string;
};

type TurnKey = {
  threadId: string;
  turnId: string;
};

export class ActiveTurnStore {
  private readonly byTurnId = new Map<string, ActiveTurn>();
  private readonly activeTurnByThreadId = new Map<string, string>();

  start(context: StartTurnContext): ActiveTurn {
    if (this.activeTurnByThreadId.has(context.threadId)) {
      throw new Error(`Thread ${context.threadId} already has an active turn`);
    }

    const turn: ActiveTurn = {
      ...context,
      accumulatedAssistantText: context.accumulatedAssistantText ?? ''
    };
    this.byTurnId.set(turn.turnId, turn);
    this.activeTurnByThreadId.set(turn.threadId, turn.turnId);
    return turn;
  }

  appendAgentDelta(event: TurnKey & { delta: string }): ActiveTurn | null {
    const turn = this.match(event);
    if (turn === null) {
      return null;
    }

    turn.accumulatedAssistantText += event.delta;
    return turn;
  }

  complete(event: TurnKey): ActiveTurn | null {
    const turn = this.match(event);
    if (turn === null) {
      return null;
    }

    this.delete(turn);
    return turn;
  }

  fail(event: TurnKey): ActiveTurn | null {
    return this.complete(event);
  }

  markThreadIdle(threadId: string): ActiveTurn | null {
    const turnId = this.activeTurnByThreadId.get(threadId);
    if (turnId === undefined) {
      return null;
    }

    const turn = this.byTurnId.get(turnId);
    if (turn === undefined) {
      this.activeTurnByThreadId.delete(threadId);
      return null;
    }

    this.delete(turn);
    return turn;
  }

  isThreadBusy(threadId: string): boolean {
    return this.activeTurnByThreadId.has(threadId);
  }

  getByTurnId(turnId: string): ActiveTurn | undefined {
    return this.byTurnId.get(turnId);
  }

  getByThreadId(threadId: string): ActiveTurn | undefined {
    const turnId = this.activeTurnByThreadId.get(threadId);
    return turnId === undefined ? undefined : this.byTurnId.get(turnId);
  }

  listActive(): ActiveTurn[] {
    return [...this.byTurnId.values()];
  }

  private match(event: TurnKey): ActiveTurn | null {
    const turn = this.byTurnId.get(event.turnId);
    if (turn === undefined || turn.threadId !== event.threadId) {
      return null;
    }

    return turn;
  }

  private delete(turn: ActiveTurn): void {
    this.byTurnId.delete(turn.turnId);
    this.activeTurnByThreadId.delete(turn.threadId);
  }
}
