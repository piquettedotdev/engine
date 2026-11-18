/**
 * An `Asker` driven by a JSON answers map instead of a terminal — the seam that
 * lets an agent (via `piquette init --answers`) run the SAME `runInterview`
 * flow a human does, with every rule it encodes (pinned-roster overrides,
 * launch-command shapes, which follow-ups apply) kept in one place.
 *
 * Questions are keyed by `questionKey(label)` — a slug of the label text. The
 * interview branches on earlier answers, so there is no fixed question list:
 * the first question with no answer (and no usable default under
 * `acceptDefaults`) throws `NeedsAnswer`, carrying the question's key, kind,
 * choices and default. The caller reports it, the agent asks its user, adds
 * the answer, and re-runs. Nothing is written until every question resolves.
 *
 * Secrets are NEVER taken from answers: a `secret()` question records the env
 * key it wanted (and whether `.env` already has it) and resolves to `""` — the
 * same as a human pressing enter to keep the current value. An answers map
 * that tries to supply one is rejected, so a key never passes through an
 * agent's context. The user fills `.env` themselves; `piquette doctor` confirms.
 */
import { readFileSync } from "node:fs";
import type { Asker, SelectChoice } from "./ask.ts";

export type AnswerValue = string | boolean | number;
export type QuestionKind = "text" | "select" | "confirm" | "secret";

export interface PendingQuestion {
  key: string;
  kind: QuestionKind;
  label: string;
  section?: string;
  choices?: { value: string; label?: string; hint?: string }[];
  default?: string | boolean;
  /** Notes the interview printed since the previous question — usually the context a human would have read right above this prompt. */
  context: string[];
}

export class NeedsAnswer extends Error {
  constructor(readonly question: PendingQuestion) {
    super(`no answer for ${question.key}`);
  }
}

export class InvalidAnswer extends Error {
  constructor(
    readonly question: PendingQuestion,
    readonly problem: string,
  ) {
    super(`invalid answer for ${question.key}: ${problem}`);
  }
}

export interface SecretRequest {
  /** The env var name, e.g. `ANTHROPIC_API_KEY`. */
  key: string;
  label: string;
  /** Whether `.env` already had a value for it when the interview ran. */
  set: boolean;
}

/** `"Which backend runs each agent?"` -> `"which_backend_runs_each_agent"`. Stable as long as the label text is. */
export function questionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The interview's last question — the "write it?" confirmation. Passing `--answers` IS that consent, so it auto-resolves to yes unless answered explicitly. */
export const WRITE_CONFIRM_KEY = questionKey("Write .piquette/piquette.config.yaml and .env?");

export interface AnswersAsker extends Asker {
  /** Keys that were asked and resolved, in order. */
  readonly answered: string[];
  readonly secrets: SecretRequest[];
  readonly notes: string[];
  /** Answer keys never matched by a question this run — usually a typo, or an answer for a branch that wasn't taken. */
  unused(): string[];
}

export function createAnswersAsker(
  answers: Record<string, AnswerValue>,
  opts: { acceptDefaults?: boolean; log?: (line: string) => void } = {},
): AnswersAsker {
  const log = opts.log ?? (() => {});
  const used = new Set<string>();
  const answered: string[] = [];
  const secrets: SecretRequest[] = [];
  const notes: string[] = [];
  let pendingContext: string[] = [];
  let section: string | undefined;

  const question = (q: Omit<PendingQuestion, "context" | "section">): PendingQuestion => ({ ...q, section, context: pendingContext });

  /** The explicit answer for `key`, or `undefined`. */
  const lookup = (key: string): AnswerValue | undefined => {
    if (!(key in answers)) return undefined;
    used.add(key);
    return answers[key];
  };

  const resolved = (key: string) => {
    answered.push(key);
    pendingContext = [];
  };

  return {
    answered,
    secrets,
    notes,
    unused: () => Object.keys(answers).filter((k) => !used.has(k)),

    async text(label, textOpts) {
      const key = questionKey(label);
      const q = question({ key, kind: "text", label, default: textOpts?.default });
      const raw = lookup(key);
      let value: string;
      if (raw !== undefined) value = String(raw);
      else if (opts.acceptDefaults && textOpts?.default !== undefined) value = textOpts.default;
      else throw new NeedsAnswer(q);
      const problem = textOpts?.validate?.(value);
      if (problem) throw new InvalidAnswer(q, problem);
      log(`${label}: ${value}`);
      resolved(key);
      return value;
    },

    async select<T extends string>(label: string, choices: SelectChoice<T>[], dflt: T): Promise<T> {
      const key = questionKey(label);
      const q = question({ key, kind: "select", label, default: dflt, choices: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) });
      const raw = lookup(key);
      let value: string;
      if (raw !== undefined) value = String(raw);
      else if (opts.acceptDefaults) value = dflt;
      else throw new NeedsAnswer(q);
      if (!choices.some((c) => c.value === value)) {
        throw new InvalidAnswer(q, `must be one of: ${choices.map((c) => c.value).join(", ")}`);
      }
      log(`${label}: ${value}`);
      resolved(key);
      return value as T;
    },

    async confirm(label, dflt) {
      const key = questionKey(label);
      const q = question({ key, kind: "confirm", label, default: dflt });
      const raw = lookup(key);
      let value: boolean;
      if (raw === undefined) {
        if (key === WRITE_CONFIRM_KEY) value = true;
        else if (opts.acceptDefaults) value = dflt;
        else throw new NeedsAnswer(q);
      } else if (typeof raw === "boolean") {
        value = raw;
      } else {
        const s = String(raw).trim().toLowerCase();
        if (["y", "yes", "true", "1"].includes(s)) value = true;
        else if (["n", "no", "false", "0"].includes(s)) value = false;
        else throw new InvalidAnswer(q, "must be true or false");
      }
      log(`${label.trim()}: ${value ? "yes" : "no"}`);
      resolved(key);
      return value;
    },

    async secret(label, secretOpts) {
      const key = questionKey(label);
      const envKey = /^[A-Za-z_][A-Za-z0-9_]*/.exec(label.trim())?.[0] ?? label.trim();
      const supplied = [key, envKey].find((k) => k in answers);
      if (supplied !== undefined) {
        used.add(supplied);
        throw new InvalidAnswer(
          question({ key, kind: "secret", label }),
          `secrets are never accepted through --answers — remove it, and have the user put ${envKey} in .env themselves`,
        );
      }
      secrets.push({ key: envKey, label, set: Boolean(secretOpts?.current) });
      resolved(key);
      return ""; // same as a human pressing enter: keep whatever .env already has
    },

    note(text) {
      notes.push(text);
      pendingContext = [...pendingContext, text];
    },
    heading(text) {
      section = text;
      pendingContext = [];
    },
    close() {},
  };
}

/** Read `--answers`'s value: a file path, `-` (stdin), or an inline JSON object. */
export function readAnswers(source: string): Record<string, AnswerValue> {
  const raw = source.trim().startsWith("{") ? source : readFileSync(source === "-" ? 0 : source, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--answers must be a JSON object of {question_key: answer}");
  return parsed as Record<string, AnswerValue>;
}
