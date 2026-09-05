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
import type { BusyEnterBehavior } from "./ops.js";
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

/** Result of {@link AgentStore.ensure}. */
export interface EnsureAgentResult {
  readonly agent: Agent | undefined;
  /**
   * Previous bound session id that failed to resume, when a replacement
   * session was minted (`replaceOnResumeFailure: true`). Absent when the
   * bound session loaded, or when replacement was not requested.
   */
  readonly replacedSessionId?: string;
}

/** Options for {@link AgentStore.ensure}. */
export interface EnsureAgentOptions {
  /**
   * When the bound session fails to resume (corrupt log, missing file,
   * persistence validation), clear the binding and create a fresh session
   * instead of leaving the user stuck. Used by the inbound message path.
   * Management commands that name a specific session (`/s switch`) leave
   * this off so a failed load does not silently mint a different id.
   */
  readonly replaceOnResumeFailure?: boolean;
}

/**
 * DSH 0.1.3 reports a held SessionHandle as a stable named error. Walk the
 * cause chain without importing the host package so this third-party bridge
 * remains runtime-decoupled from `@deepseek-ai/*`.
 */
function isSessionOwnershipConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (
      candidate.name === "SessionAlreadyOwnedError" ||
      candidate.name === "SessionOwnershipLostError" ||
      (typeof candidate.message === "string" && /already owned by an active write handle|write ownership was lost/i.test(candidate.message))
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
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
 * GUI uses (`session-<uuid>`, the same mint the session controller uses). Uniform
 * ids keep WeChat-created sessions indistinguishable from GUI-created ones
 * everywhere (lists, workspace accounting, log exports).
 */
export function mintSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

export class AgentStore {
  /**
   * The DSH 0.1.3 persistence layer takes a single write owner per session.
   * Keep cold create/resume attempts for one WeChat user ordered so a burst of
   * messages after restart cannot make the second caller lose the lock and be
   * mistaken for a corrupt session.
   */
  private readonly ensureInFlight = new Map<string, Promise<EnsureAgentResult>>();

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
   * Returns `{ agent }` (agent undefined when the agents service is
   * unavailable or create/resume failed). With `replaceOnResumeFailure`,
   * a corrupt or unreadable bound session is unbound and replaced.
   *
   * Calls for one user are serialized across the async create/resume boundary.
   * A later caller re-checks the live registry after the earlier call
   * publishes, so it reuses the same agent instead of opening the session a
   * second time.
   */
  async ensure(user: UserState, options?: EnsureAgentOptions): Promise<EnsureAgentResult> {
    const previous = this.ensureInFlight.get(user.userId);
    const waitForPrevious = previous === undefined
      ? Promise.resolve()
      : previous.then(() => undefined, () => undefined);
    const current = waitForPrevious.then(() => this.ensureOnce(user, options));
    this.ensureInFlight.set(user.userId, current);
    try {
      return await current;
    } finally {
      if (this.ensureInFlight.get(user.userId) === current) {
        this.ensureInFlight.delete(user.userId);
      }
    }
  }

  private async ensureOnce(user: UserState, options?: EnsureAgentOptions): Promise<EnsureAgentResult> {
    const agents = this.agents();
    if (!agents) return { agent: undefined };

    let replacedSessionId: string | undefined;

    if (user.sessionId) {
      const live = agents.get(user.sessionId);
      if (live) return { agent: live };
      try {
        const handle = await agents.resume({
          resumeSessionId: user.sessionId,
          setup: agentSetup,
        });
        await this.attachToWorkspace(user.cwd, user.sessionId);
        return { agent: handle.agent };
      } catch (err) {
        console.error(`[dsh-wechat] resume session ${user.sessionId} failed: ${String(err)}`);
        // A 0.1.3 SessionHandle ownership conflict means another lifecycle
        // (possibly another DSH process) owns this exact session. It is not
        // corruption and must never trigger replacement of the user's binding.
        if (isSessionOwnershipConflict(err)) return { agent: undefined };
        if (!options?.replaceOnResumeFailure) return { agent: undefined };
        replacedSessionId = user.sessionId;
        user.sessionId = "";
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
      return { agent: handle.agent, replacedSessionId };
    } catch (err) {
      console.error(`[dsh-wechat] create session failed: ${String(err)}`);
      return { agent: undefined, replacedSessionId };
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

  /**
   * Deliver a user-role message to the agent.
   *
   * `mode` mirrors the DSH `ui-conversation.busyEnter` preference (the GUI's
   * 「繁忙时 Enter 键行为」): `"queue"` routes through `agent.followup` — an
   * ordinary follow-up turn, the behavior while idle and the historical
   * default; `"steer"` routes through `agent.steer` — an idle driver starts a
   * turn, a running driver consumes the message at its nearest step boundary
   * (a closed window degrades to the next waking queue turn, never lost).
   * The caller resolves the mode from agent.status + the shared setting.
   */
  followup(
    agent: Agent,
    content: ContentBlock[],
    mode: BusyEnterBehavior = "queue",
    onCreated?: (messageId: string) => void,
  ): string {
    const message = createUserMessage({
      content,
      // kind 'user' — identical to messages sent from the GUI chat box, so
      // the WeChat user's messages render as ordinary user messages (a
      // 'plugin' source renders as "context injection" in the GUI).
      source: { kind: "user" },
    });
    // Record the minted id BEFORE followup/steer. Those calls synchronously
    // emit `agent/inbox/spliced`; the surface-prompt marker must already
    // know this id or the splice handler treats the WeChat message as GUI.
    onCreated?.(message.id);
    if (mode === "steer") {
      agent.steer(message);
    } else {
      agent.followup(message);
    }
    return message.id;
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
 * registered here anymore — it lives in a global dynamic runtime context
 * registered by index.ts (`dsh-wechat-surface`), whose text is evaluated per assembly
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
