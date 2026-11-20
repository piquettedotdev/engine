/**
 * `watch.resume_from_wip` (#14): start a re-claimed issue from the work its
 * previous, failed run preserved, instead of from `origin/<base>`.
 *
 * Everything here FAILS CLOSED: any doubt returns `null` and the caller does
 * what it always did — a fresh worktree off `origin/<base>`. The marker that
 * points at the preserved work is a tracker comment anyone with comment access
 * can forge (the GitHub provider does not check its author), so every field is
 * validated before it is trusted, and the fetched ref must still sit on the
 * exact sha the marker names.
 */
import type { GitHandle } from "./git_helper.ts";
import type { WipRef } from "./issues/provider.ts";
import { protectedPathsIn } from "./permissions.ts";

/** What the previous attempt got to, read from the local trace DB (`WatchResumeDeps.readPriorRun`). */
export interface PriorRunSummary {
  /** The first failed phase, e.g. `build` or `prove_head`. */
  phase?: string;
  /** Its error text, uncapped — `resumeSection` caps it. */
  error?: string;
  /** A `prove_*` phase's logged next-step list. */
  next?: string[];
}

const MAX_ERROR_CHARS = 1000;
const MAX_NEXT_ITEMS = 10;
const MAX_NEXT_CHARS = 300;

const isHex = (v: unknown, min: number, max: number): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${min},${max}}$`).test(v);
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * The marker's `wip`, or `null` unless every field is what `preserveWork` would
 * have written for THIS issue: the branch is exactly `<canonical branch>-wip-<sha prefix>`,
 * the adw_id is this issue's, the shas are hex. `phases` is optional — a
 * malformed range is dropped (the resume still works, just without phase skipping).
 */
export function validateWipMarker(raw: unknown, ctx: { canonicalBranch: string; adwId: string }): WipRef | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (!isHex(w.sha, 7, 40)) return null;
  if (!isHex(w.base_sha, 7, 40)) return null;
  if (typeof w.branch !== "string" || typeof w.chain !== "string" || typeof w.at !== "string") return null;
  if (w.adw_id !== ctx.adwId) return null;
  const prefix = `${ctx.canonicalBranch}-wip-`;
  if (!w.branch.startsWith(prefix)) return null;
  const suffix = w.branch.slice(prefix.length);
  if (!isHex(suffix, 7, 40) || !w.sha.startsWith(suffix)) return null;
  const out: WipRef = { branch: w.branch, sha: w.sha, adw_id: w.adw_id, chain: w.chain, base_sha: w.base_sha, at: w.at };
  const ph = w.phases as { from?: unknown; to?: unknown } | undefined;
  if (ph && isSeq(ph.from) && isSeq(ph.to) && ph.from <= ph.to) out.phases = { from: ph.from, to: ph.to };
  return out;
}

export interface ResumeResult {
  /** The preserved ref the worktree now starts from. */
  wipBranch: string;
  /** True when `origin/<base>` had moved and was merged in. */
  merged: boolean;
}

/**
 * Creates the issue's worktree from the preserved ref, or returns `null`
 * (after removing anything it made) when it cannot be trusted. On `null` the
 * caller creates the fresh worktree itself.
 *
 *  1. fetch the ref, 2. it must still be at the sha the marker recorded,
 *  3. no protected path may differ from the base (a successful protected-file
 *  revert is already in history; a failed one leaves the breach in the tree),
 *  4. the tip must contain current `origin/<base>` — `pushWorktreeHead` refuses
 *  to push anything that does not — so merge it in when it moved; a conflict
 *  means start fresh.
 */
export function tryResumeFromWip(
  deps: { git: GitHandle; worktreeGit: (path: string) => GitHandle; baseBranch: string; log: (message: string) => void },
  w: { issueId: string; worktreePath: string; branch: string; wip: WipRef; protectedFiles: string[]; cleanup: () => void },
): ResumeResult | null {
  const base = `origin/${deps.baseBranch}`;
  const ref = `origin/${w.wip.branch}`;
  const fresh = (why: string): null => {
    deps.log(`watch: ${w.issueId}: ${why} — starting fresh from ${base}`);
    w.cleanup();
    return null;
  };
  try {
    try {
      deps.git.fetch("origin", w.wip.branch);
    } catch (error) {
      return fresh(`preserved work ${w.wip.branch} is gone from origin (${(error as Error).message})`);
    }
    if (deps.git.rev(ref) !== w.wip.sha) return fresh(`preserved work ${w.wip.branch} no longer matches the sha the issue marker recorded`);
    deps.git.worktreeAdd(w.worktreePath, w.branch, ref);
    const wt = deps.worktreeGit(w.worktreePath);
    const hits = protectedPathsIn(wt.diffFiles(wt.mergeBase(base)), w.protectedFiles);
    if (hits.length > 0) return fresh(`preserved work ${w.wip.branch} changes protected path(s) (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", ..." : ""})`);
    let merged = false;
    if (!wt.isAncestor(base)) {
      if (!wt.merge(base)) return fresh(`base moved and merging ${base} into ${w.wip.branch} conflicted`);
      merged = true;
    }
    return { wipBranch: w.wip.branch, merged };
  } catch (error) {
    return fresh(`could not resume from ${w.wip.branch} (${(error as Error).message})`);
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/** The section appended to the issue prompt on a resumed run. Plain text, no markers a human comment could imitate. */
export function resumeSection(r: ResumeResult & { baseBranch: string; prior?: PriorRunSummary }): string {
  const lines = [
    "## Resuming a previous attempt",
    "",
    `A previous attempt at this issue did not finish. Its work is already committed on this branch (it came from \`${r.wipBranch}\`${r.merged ? `, merged with the latest \`${r.baseBranch}\`` : ""}). Continue from it; do not redo work that is already there.`,
  ];
  const p = r.prior;
  if (p?.phase) lines.push("", `It stopped at the \`${p.phase}\` phase${p.error ? ` with this error:\n\n${clip(p.error.trim(), MAX_ERROR_CHARS)}` : "."}`);
  else lines.push("", "Why it stopped is not recorded here; check the state of the tree before building on it.");
  const next = (p?.next ?? []).slice(0, MAX_NEXT_ITEMS).map((n) => clip(String(n), MAX_NEXT_CHARS));
  if (next.length > 0) lines.push("", "The verification step suggested these next steps:", ...next.map((n) => `- ${n}`));
  return lines.join("\n");
}
