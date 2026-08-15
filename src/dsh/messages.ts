/**
 * Vendored message construction helpers.
 *
 * These mirror `createUserMessage` from `@deepseek-ai/dsh-llm` (lib/types/
 * message.js): spread the input, mint a fresh `crypto.randomUUID()` id,
 * deep-freeze a detached clone. Vendored so the bridge has zero runtime
 * dependency on `@deepseek-ai/*` packages (which are not resolvable from a
 * third-party plugin's location in the profile node_modules).
 */

import crypto from "node:crypto";
import type { ContentBlock, UserMessage, UserMessageSource } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Create one identified user-role message and freeze it before publication. */
export function createUserMessage(input: {
  content: ContentBlock[];
  source: UserMessageSource;
  /** Optional explicit id (defaults to a fresh randomUUID). */
  id?: string;
}): UserMessage {
  return deepFreeze({
    ...input,
    id: input.id ?? crypto.randomUUID(),
    role: "user",
  }) as unknown as UserMessage;
}
