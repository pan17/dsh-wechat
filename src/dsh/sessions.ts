/**
 * DSH session mapper: binds a WeChat user to a live DSH agent.
 *
 * Creates fresh agents through `ctx.agents.create` (minting a durable
 * session id) or resumes persisted ones through `ctx.agents.resume` after
 * a DSH restart. All service access goes through `ctx.get(...)` with
 * undefined checks — this plugin has zero runtime coupling to
 * `@deepseek-ai/*` packages.
 */

import crypto from "node:crypto";
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

/** Minimal workspace entity surface (dsh-workspace). */
interface WorkspaceEntity {
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  attachSession(sessionId: string): Promise<void>;
}

/**
 * Mint a durable session id for a WeChat-bound session — the SAME format the
 * GUI uses (`session-<uuid>`, dsh-host-apiproxy's session.create). Uniform
 * ids keep WeChat-created sessions indistinguishable from GUI-created ones
 * everywhere (lists, workspace accounting, log exports).
 */
export function mintSessionId(): string {
  return `session-${crypto.randomUUID()}`;
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
  async ensure(user: UserState): Promise<Agent | undefined> {
    const agents = this.agents();
    if (!agents) return undefined;

    if (user.sessionId) {
      const live = agents.get(user.sessionId);
      if (live) return live;
      try {
        const handle = await agents.resume({
          resumeSessionId: user.sessionId,
          setup: agentSetup,
        });
        await this.attachToWorkspace(user.cwd, user.sessionId);
        return handle.agent;
      } catch (err) {
        console.error(`[dsh-wechat] resume session ${user.sessionId} failed: ${String(err)}`);
        return undefined;
      }
    }

    try {
      // The preset this session will actually run: the deployment default
      // (settings document first — the same one the GUI edits and /preset
      // switch writes). Recording it in the header (like the GUI's
      // composeAgent does) keeps /session list's Preset column populated and
      // makes a later resume mount the same composition.
      const rosterDefault = this.ctx.get<{ defaultId?: string }>("agentPresets")?.defaultId;
      const presetForSession = rosterDefault;
      const sessionId = mintSessionId();
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: user.cwd,
          ...(presetForSession ? { agentPreset: presetForSession } : {}),
        },
        setup: agentSetup,
      });
      // Persist the binding so a later restart resumes this session.
      user.sessionId = sessionId;
      await this.attachToWorkspace(user.cwd, sessionId);
      return handle.agent;
    } catch (err) {
      console.error(`[dsh-wechat] create session failed: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Account the session to the workspace owning `cwd` (create it on first
   * use), exactly like the GUI's session.create remote does via
   * `workspace.attachSession`. Without this, WeChat-created sessions fall
   * into the sidebar's "ungrouped" bucket: the workspace registry derives
   * membership from its durable `sessionIds` records, which only
   * `attachSession` (or the startup bootstrap) populates.
   */
  private async attachToWorkspace(cwd: string, sessionId: string): Promise<void> {
    const registry = this.ctx.get<{
      create(path: string, title?: string): Promise<WorkspaceEntity>;
      resolveByPath(path: string): Promise<WorkspaceEntity | undefined>;
    }>("workspaceRegistry");
    if (!registry) return;
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (!workspace) workspace = await registry.create(cwd);
      await workspace.attachSession(sessionId);
    } catch (err) {
      // Non-fatal: the session still works, it just shows ungrouped.
      console.error(`[dsh-wechat] attach session ${sessionId} to workspace failed: ${String(err)}`);
    }
  }

  /** Queue a user-role message as a follow-up turn on the agent. */
  followup(agent: Agent, content: ContentBlock[], messageId?: string): void {
    agent.followup(
      createUserMessage({
        content,
        // kind 'user' — identical to messages sent from the GUI chat box, so
        // the WeChat user's messages render as ordinary user messages (a
        // 'plugin' source renders as "context injection" in the GUI).
        source: { kind: "user" },
        ...(messageId ? { id: messageId } : {}),
      }),
    );
  }
}

/**
 * Agent-scoped composition applied to every WeChat-bound session (fresh
 * create or resume): a preset mount joins the agent to its recorded (or
 * deployment-default) agent preset so the preset's tools and prompt sections
 * cover it — the same composition the GUI's `composeAgent` installs — and a
 * model-selection pair of waterfalls keeps the prompt variables and request
 * routing populated exactly like the GUI does. Registered on the agent's own
 * scoped context so it never leaks into other sessions.
 *
 * NOTE: the WeChat surface prompt ("you are chatting through WeChat") is NOT
 * registered here anymore — it lives in a global dynamic section registered
 * by index.ts (`dsh-wechat-surface`), whose text is evaluated per assembly
 * from the bridge's per-session message-source map. That makes the prompt
 * follow the *message source* (WeChat vs GUI), so any session — old or new,
 * GUI- or WeChat-created — gets the WeChat prompt exactly while WeChat
 * messages drive it, and never while GUI messages drive it.
 */
async function agentSetup(agentCtx: unknown): Promise<void> {
  const ctx = agentCtx as {
    agent?: {
      session?: {
        header?: { id?: string; agentPreset?: string };
        requestHeader?: () =>
          | {
              config?: {
                provider?: string;
                model?: string;
                reasoningEffort?: string;
              };
            }
          | undefined;
      };
    };
    get?: <T = unknown>(name: string) => T | undefined;
    on?: (event: string, listener: (...args: unknown[]) => unknown) => void;
  };

  // Preset mount — the GUI's composeAgent equivalent. The session's recorded
  // preset (header.agentPreset, written at creation) decides its tools and
  // prompt; an absent one falls back to the roster default (`mount` with no
  // id). Without this, WeChat-created sessions lack the preset's tools
  // (pwsh, fs, web, skill, …) and prompt sections entirely.
  const presets = ctx.get?.<{
    mount(agentCtx: unknown, id?: string): Promise<unknown>;
  }>("agentPresets");
  if (presets) {
    try {
      await presets.mount(agentCtx, ctx.agent?.session?.header?.agentPreset);
    } catch (err) {
      console.error(`[dsh-wechat] preset mount failed: ${String(err)}`);
    }
  }

  // Model selection, GUI-equivalent precedence: the session's own latest
  // request wins, otherwise the deployment's default model (agentDefaultModel
  // service — the same fallback the Web surface's `selectionFor` uses).
  // Without it, agents created/resumed outside the GUI have no model route:
  // the persona's `{{model}}` variable fails to render and requests cannot
  // resolve a provider/model. This bridge cannot import `@deepseek-ai/dsh-agent`
  // at runtime, so the two waterfalls replicate `installModelSelection`'s
  // cooperative pattern exactly: snapshot the selection into prompt assembly
  // and apply it to every request config.
  const logged = ctx.agent?.session?.requestHeader?.()?.config;
  const defaults = ctx.get?.<{ currentSelection(): ModelSelection }>(
    "agentDefaultModel",
  )?.currentSelection();
  const selected: ModelSelection | undefined =
    logged?.provider && logged.model
      ? {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
        }
      : defaults;
  if (!selected?.provider || !selected.model) return;

  ctx.on?.("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = (await (next as () => Promise<{
      variables?: Record<string, unknown>;
    }>)()) as { variables?: Record<string, unknown> };
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    };
  });
  ctx.on?.("agent/request", async (_payload, next) => {
    const resolved = (await (next as () => Promise<Record<string, unknown>>)()) as Record<string, unknown>;
    return {
      ...resolved,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selected.reasoningEffort }),
    };
  });
}

/** One resolved model selection (dsh-agent-default-model / request header). */
interface ModelSelection {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}
