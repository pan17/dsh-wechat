/**
 * DSH session mapper: binds a WeChat user to a live DSH agent.
 *
 * Creates fresh agents through `ctx.agents.create` (minting a durable
 * session id) or resumes persisted ones through `ctx.agents.resume` after
 * a DSH restart. All service access goes through `ctx.get(...)` with
 * undefined checks — this plugin has zero runtime coupling to
 * `@deepseek-ai/*` packages.
 */

import { createUserMessage } from "./messages.js";
import type { Agent, AgentHandle, ContentBlock, CreateAgentOptions, ResumeAgentOptions } from "./types.js";
import type { UserState } from "../state.js";

/** Minimal structural surface of the `agents` registry service. */
export interface AgentsService {
  create(options: CreateAgentOptions): Promise<AgentHandle>;
  resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  get(id: string): Agent | undefined;
  list(): Agent[];
}

/** Minimal structural surface of `ctx` (Cordis). */
export interface BridgeContext {
  get<T = unknown>(name: string): T | undefined;
  on(event: string, listener: (...args: unknown[]) => unknown): () => void;
}

/** Mint a durable session id for a WeChat-bound session. */
export function mintSessionId(): string {
  return `wx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class AgentStore {
  constructor(private readonly ctx: BridgeContext) {}

  private agents(): AgentsService | undefined {
    return this.ctx.get<AgentsService>("agents");
  }

  /** The live agent for a bound user state, if any. */
  get(user: UserState): Agent | undefined {
    if (!user.sessionId) return undefined;
    return this.agents()?.get(user.sessionId);
  }

  /**
   * Ensure a live agent for the user state. Creates a fresh session when
   * none is bound yet; resumes the persisted session otherwise.
   * Returns the live agent, or undefined when the agents service is
   * unavailable.
   */
  async ensure(user: UserState, agentPreset?: string): Promise<Agent | undefined> {
    const agents = this.agents();
    if (!agents) return undefined;

    const setup = agentSetup;

    if (user.sessionId) {
      const live = agents.get(user.sessionId);
      if (live) return live;
      try {
        const handle = await agents.resume({
          resumeSessionId: user.sessionId,
          setup,
        });
        return handle.agent;
      } catch (err) {
        console.error(`[dsh-wechat] resume session ${user.sessionId} failed: ${String(err)}`);
        return undefined;
      }
    }

    try {
      const sessionId = mintSessionId();
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: user.cwd,
          ...(agentPreset ? { agentPreset } : {}),
        },
        setup,
      });
      // Persist the binding so a later restart resumes this session.
      user.sessionId = sessionId;
      return handle.agent;
    } catch (err) {
      console.error(`[dsh-wechat] create session failed: ${String(err)}`);
      return undefined;
    }
  }

  /** Queue a user-role message as a follow-up turn on the agent. */
  followup(agent: Agent, content: ContentBlock[]): void {
    agent.followup(
      createUserMessage({
        content,
        // kind 'user' — identical to messages sent from the GUI chat box, so
        // the WeChat user's messages render as ordinary user messages (a
        // 'plugin' source renders as "context injection" in the GUI).
        source: { kind: "user" },
      }),
    );
  }
}

/**
 * Agent-scoped composition applied to every WeChat-bound session (fresh
 * create or resume): a system-prompt section tells the model it is chatting
 * through WeChat. Registered on the agent's own scoped context so it never
 * leaks into other sessions — and unlike a per-message text block, it never
 * pollutes user-message content (which the session-title generator reads).
 */
function agentSetup(agentCtx: unknown): void {
  const systemPrompt = (agentCtx as { get?: <T>(name: string) => T | undefined })?.get?.<{
    section(section: {
      name: string;
      order: number;
      text: string;
    }): unknown;
  }>("systemPrompt");
  systemPrompt?.section?.({
    name: "dsh-wechat-surface",
    order: 50,
    text: "你正在通过微信(WeChat)与用户聊天。回复会发送到微信，请使用适合微信阅读的格式（纯文本、适度使用 emoji、避免过长的表格）。",
  });
}
