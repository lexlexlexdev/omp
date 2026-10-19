/**
 * Secret Mask for omp. Auto-discovered from ~/.omp/agent/extensions/.
 *
 * Restart omp after installing. In main-session interactive or RPC chat, send
 * NAME=value on its own line (quotes allow spaces). Every standalone assignment
 * is treated as a secret, regardless of its name. Empty values are not registered.
 * Chat stores NAME=__SECRET_NAME__; bash commands use "$NAME" or "${NAME}".
 * Known literal values are masked in completed tool results, conversation context,
 * finalized assistant text, and provider payloads on transports honoring onPayload.
 *
 * Values are exported to process.env, may overwrite existing variables, and are
 * available to all child processes and sessions, not only commands referencing them.
 * No secret file is created. Old values remain masked after reassignment; restart
 * omp to clear registrations. Do not reload extensions while secrets are registered:
 * reimport can reset masking state while exported environment variables remain.
 *
 * Not a sandbox or a secure input widget. Composer history, earlier extensions,
 * streamed output, artifacts/logs, binary attachments, encrypted replay, encoded
 * values, and external transmission are not protected. Registration does not cover
 * print/ACP prompts, focused-subagent chat, or programmatic message injection.
 * Do not enter secrets through those surfaces. Previously stored text is not erased.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Process-lifetime state is shared with child-session extension factories.
// Values are deliberately exported: every child process may inherit them.
const variables = new Map<string, string>();
const knownValues = new Map<string, string>();
const assignment = /^([\t ]*)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\t \r\n"'`]+))([\t ]*)$/;
const placeholder = /^__SECRET_[A-Za-z_][A-Za-z0-9_]*__$/;
const placeholders = /__SECRET_([A-Za-z_][A-Za-z0-9_]*)__/g;
let maskPattern: RegExp | undefined;

function registerLine(line: string): string {
  const match = assignment.exec(line);
  if (!match) return line;
  const [, indent, name, quoted, singleQuoted, bare, trailing] = match;
  const value = quoted ?? singleQuoted ?? bare;
  if (!value || placeholder.test(value)) return line;
  // Do not silently retain an older environment value if an assignment fails.
  if (value.includes("\0")) throw new Error(`Secret variable ${name} contains a NUL byte.`);
  process.env[name] = value;
  variables.set(name, value);
  knownValues.set(value, `__SECRET_${name}__`);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternatives = [...knownValues.keys()].sort((a, b) => b.length - a.length).map(escape);
  maskPattern = new RegExp(`__SECRET_[A-Za-z_][A-Za-z0-9_]*__|${alternatives.join("|")}`, "g");
  return `${indent}${name}=__SECRET_${name}__${trailing}`;
}

function mask(text: string): string {
  if (!maskPattern) return text;
  return text.replace(maskPattern, value => placeholder.test(value) ? value : knownValues.get(value)!);
}

function maskedCopy<T>(value: T): T {
  if (typeof value === "string") return mask(value) as T;
  if (!value || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(maskedCopy) as T;
  const record = value as Record<string, unknown>;
  // Attachments and opaque replay data are not plaintext.
  if (["media", "image", "input_image", "image_url", "audio", "input_audio", "file", "input_file"].includes(String(record.type))) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    copy[key] = ["type", "role", "id", "toolCallId", "tool_call_id", "textSignature", "thinkingSignature", "encrypted_content"].includes(key)
      ? item : maskedCopy(item);
  }
  return copy as T;
}

function instructions(): string {
  return `Secret variables available to shell commands: ${[...variables.keys()].join(", ")}. Use $NAME or \${NAME}; registered values are in the omp process environment. Tokens __SECRET_NAME__ are placeholders, not literal credentials. Never print or transmit secret values except to the intended service. Do not ask the user to resend registered secrets. Values are lost when omp restarts.`;
}

export default function secretMask(pi: ExtensionAPI) {
  pi.setLabel("Secret Mask");

  // Interactive main-session and RPC ingress only: not print/ACP/subagent chat.
  pi.on("input", event => ({
    text: mask(event.text.split(/\r?\n/).map(registerLine).join("\n")),
  }));

  pi.on("before_agent_start", event => {
    if (!variables.size) return;
    return { systemPrompt: [...event.systemPrompt.map(mask), instructions()] };
  });

  pi.on("context", event => {
    if (!knownValues.size) return;
    return { messages: maskedCopy(event.messages) };
  });

  // Final provider-boundary scrub also covers system text and auxiliary requests
  // on transports honoring onPayload. Opaque encrypted replay cannot be scrubbed.
  pi.on("before_provider_request", event => {
    if (!knownValues.size) return;
    return maskedCopy(event.payload);
  });

  pi.on("tool_call", event => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    let missing: string | undefined;
    const command = event.input.command.replace(placeholders, (token, name: string) => {
      if (!variables.has(name)) {
        missing = name;
        return token;
      }
      return `\${${name}}`;
    });
    if (missing) return { block: true, reason: `Secret variable ${missing} is not registered in this omp process.` };
    if (command !== event.input.command) return { input: { ...event.input, command } };
  });

  // Post-execution masking cannot retract streaming output or raw artifact files.
  pi.on("tool_result", event => {
    if (!knownValues.size) return;
    return { content: maskedCopy(event.content), details: maskedCopy(event.details) };
  });

  pi.on("assistant_message", event => {
    if (!knownValues.size) return;
    return {
      content: event.message.content.map(block => block.type === "text" ? { ...block, text: mask(block.text) } : block),
    };
  });
}
