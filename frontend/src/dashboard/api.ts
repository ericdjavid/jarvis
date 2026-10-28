/** Typed client for the /api/runs and /api/sessions surfaces. */

export interface RunRow {
  id: string;
  project_name: string;
  project_path: string;
  prompt: string;
  origin: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  resume_from: string | null;
  result_text: string;
  summary: string;
  error: string;
  exit_code: number | null;
  pid: number | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  num_turns: number;
  model: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface RunEvent {
  id: number;
  run_id: string;
  seq: number;
  ts: number;
  kind: string;
  payload: string;
}

export interface RunStats {
  period: string;
  by_status: Record<string, number>;
  total_runs: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

/**
 * One rate-limit window as `/api/usage/limits` reports it.
 *
 * `utilization` is a percentage, and it is `null` whenever nobody has
 * measured this window yet — which is the normal state of a freshly started
 * JARVIS, because the reading only arrives when the brain takes a turn. Null
 * is NOT zero and must never be drawn as an empty gauge.
 */
export interface UsageWindow {
  key: string;
  label: string;
  utilization: number | null;
  resets_at: number | null;
  status: string;
  observed_at: number | null;
  age_sec: number | null;
  /** The reading is older than `stale_after_sec`. */
  stale: boolean;
  /** The window rolled over since we looked: whatever we hold is history. */
  expired: boolean;
}

export interface UsageSnapshot {
  /** False when there has been no observation at all. */
  measured: boolean;
  observed_at: number | null;
  age_sec: number | null;
  stale: boolean;
  stale_after_sec: number;
  status: string;
  windows: UsageWindow[];
}

/** Thrown by `get()` on a non-OK response; carries the HTTP status so a
 * caller can tell "endpoint doesn't exist yet" (404) from a real failure. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`${status} ${url}`);
    this.status = status;
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, url);
  return res.json() as Promise<T>;
}

export async function listRuns(limit = 50): Promise<RunRow[]> {
  const body = await get<{ runs: RunRow[] }>(`/api/runs?limit=${limit}`);
  return body.runs;
}

export async function getRun(id: string): Promise<RunRow> {
  const body = await get<{ run: RunRow }>(`/api/runs/${id}`);
  return body.run;
}

export async function getEvents(
  id: string, afterSeq = 0, limit = 200,
): Promise<{ events: RunEvent[]; total: number }> {
  return get<{ events: RunEvent[]; total: number }>(
    `/api/runs/${id}/events?after_seq=${afterSeq}&limit=${limit}`,
  );
}

export async function getStats(period = "day"): Promise<RunStats> {
  return get<RunStats>(`/api/runs/stats?period=${period}`);
}

/**
 * Usage against the subscription's limits. JARVIS runs on the user's Claude
 * subscription, so this — not a dollar figure — is what "how much is left"
 * means here.
 */
export async function getUsageLimits(): Promise<UsageSnapshot> {
  return get<UsageSnapshot>("/api/usage/limits");
}

export async function cancelRun(id: string): Promise<void> {
  await fetch(`/api/runs/${id}`, { method: "DELETE" });
}

export async function retryRun(id: string): Promise<string> {
  const res = await fetch(`/api/runs/${id}/retry`, { method: "POST" });
  const body = (await res.json()) as { run_id: string };
  return body.run_id;
}

/** A live Claude Code session, as tracked by session_watch.py. */
export type SessionState =
  | "needs_you" | "working" | "idle" | "shell" | "fresh" | "gone" | "unknown";

export interface SessionRow {
  session_id: string;
  voice_name: string;
  roster_name: string;
  /** Stable while the session lives; what the user says out loud ("la 3"). */
  number?: number;
  project: string;
  cwd: string;
  state: SessionState;
  needs: string | null;
  needs_a_human_hand: boolean;
  title: string | null;
  summary: string | null;
  last_prompt: string | null;
  last_text: string | null;
  recent_tools: string[];
  /**
   * TWO CLOCKS, and they are not interchangeable. `started` is when the
   * conversation began; `since` is when its CURRENT STATE began. The largest
   * gap measured between them on the live roster was 102 HOURS. Either may be
   * `null` — a roster entry can carry neither stamp — and null means "not
   * recorded", never 0, which would render as 1970 and read as a fact.
   */
  started: number | null;
  since: number | null;
  origin: string;
  steerable: boolean;
  pids: number[];
  primary_pid: number | null;
  /**
   * Is this the conversation the user is sitting at, in this project?
   * `false` with a reason of "equally live as another here" means the
   * signals could not separate two conversations — not that neither
   * matters. See `_mark_primary` in session_watch.py for the whole rule.
   */
  primary: boolean;
  primary_reason: string;
  /** Subagent transcripts under this conversation, and how many were
   * written recently enough to count as working. A file age, not a
   * process check. */
  agents_seen: number;
  agents_active: number;
  /** `agents_seen` hit the watcher's cap: it is a floor, not a total. */
  agents_capped: boolean;
}

export interface SessionsSnapshot {
  sessions: SessionRow[];
  projects: Record<string, string[]>;
  taken_at: number;
}

export async function listSessions(): Promise<SessionsSnapshot> {
  return get<SessionsSnapshot>("/api/sessions");
}

/** What `window_focus.py` answered. Only "focused" means a window moved. */
export type FocusOutcome =
  | "focused" | "no_tty" | "not_found" | "not_permitted" | "failed";

/** Raise the terminal window this conversation runs in (Terminal.app or
 * Warp). The server picks the pid from its own snapshot. */
export async function focusSession(sessionId: string): Promise<FocusOutcome> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/focus`,
    { method: "POST" });
  if (!res.ok) return "failed";
  const body = (await res.json()) as { outcome: FocusOutcome };
  return body.outcome;
}

/** One line for the user, per outcome. */
export const FOCUS_MESSAGES: Record<FocusOutcome, string> = {
  focused: "Fenêtre ouverte",
  no_tty: "Cette session n'a pas de terminal",
  not_found: "Fenêtre introuvable (onglet Warp en arrière-plan ?)",
  not_permitted: "Autorise JARVIS : Réglages › Confidentialité › Accessibilité (Warp)",
  failed: "Échec de l'ouverture de la fenêtre",
};

/** A conversation that is no longer running (`session_history.py`). */
export interface ClosedSession {
  session_id: string;
  name: string | null;
  title: string | null;
  last_prompt: string | null;
  cwd: string;
  project: string;
  ended: number;
}

export async function listClosedSessions(limit = 15): Promise<ClosedSession[]> {
  const body = await get<{ sessions: ClosedSession[] }>(`/api/sessions/history?limit=${limit}`);
  return body.sessions;
}

/** `claude --resume` in a new Warp window. */
export async function reopenSession(sessionId: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/history/${encodeURIComponent(sessionId)}/reopen`,
    { method: "POST" });
  if (!res.ok) return false;
  return Boolean(((await res.json()) as { ok: boolean }).ok);
}

/**
 * JARVIS's long-term memory: a folder of plain Markdown at
 * `<JARVIS_DATA_DIR>/jarvis/` (see `data_paths.py` / `jarvis_memory.py`).
 * This client targets the contract specified for a not-yet-built backend
 * endpoint — see the Memory view report for the exact shape. A 404 on
 * either call means the endpoint hasn't shipped, not that memory is empty.
 */

/** One line of MEMORY.md — the curated index loaded into every conversation. */
export interface MemoryIndexEntry {
  title: string;
  slug: string;
  hook: string;
}

/** One file under memory/. `title` is the file's `# ` header, or its slug
 * if the header is missing/unreadable. `modified` is epoch seconds (mtime). */
export interface MemoryFileEntry {
  slug: string;
  title: string;
  modified: number;
}

/** One file under projects/. Same shape as MemoryFileEntry. */
export interface ProjectNoteEntry {
  slug: string;
  title: string;
  modified: number;
}

/** One file under journal/. `when` is parsed from the filename's own
 * fixed-width timestamp, not mtime — a hand-edit of an old entry must not
 * make it look newest. `reason` is best-effort (may be "" if the filename
 * doesn't parse, e.g. renamed by hand). */
export interface JournalEntry {
  slug: string;
  when: number;
  reason: string;
}

export interface MemorySnapshot {
  /** Absolute path to the brain's home folder on disk, so the dashboard
   * can show the user exactly where to go to edit it. */
  path: string;
  index: MemoryIndexEntry[];
  memories: MemoryFileEntry[];
  projects: ProjectNoteEntry[];
  journal: JournalEntry[];
  /** slug of the most recent journal entry (same one the brain prepends
   * on startup), or null if the journal is empty. */
  latest_journal_slug: string | null;
}

export type MemoryKind = "memory" | "project" | "journal";

export interface MemoryDoc {
  slug: string;
  text: string;
}

export async function getMemory(): Promise<MemorySnapshot> {
  return get<MemorySnapshot>("/api/memory");
}

export async function getMemoryDoc(kind: MemoryKind, slug: string): Promise<MemoryDoc> {
  return get<MemoryDoc>(`/api/memory/${kind}/${encodeURIComponent(slug)}`);
}

/**
 * Projects — the master-detail JOIN of session_watch, run_store, builds and
 * repo_read (see `projects_view.py`). The list shape is deliberately cheap
 * (no session/run payload, no filesystem walk); the detail shape adds both,
 * fetched only for the one project a user opened.
 */

/** The cheap row for the project list. `latest_run` is `null` — not a
 * fabricated run — when nothing of JARVIS's has ever run here. */
export interface ProjectListItem {
  name: string;
  primary_path: string;
  paths: string[];
  /** False when the directory is gone from disk. Not the same as "quiet". */
  directory_exists: boolean;
  /** Every conversation known for this project, DEAD ONES INCLUDED. */
  session_count: number;
  /** Of those, the ones that are still conversations — not `gone`, not
   * `fresh`. Zero here with a non-zero `session_count` is a project that has
   * finished, not one that is idling. */
  live_session_count: number;
  needs_you_count: number;
  active: boolean;
  last_activity: number | null;
  latest_run: RunRow | null;
}

export interface PlanTaskRow {
  number: number;
  title: string;
  steps_done: number;
  steps_total: number;
  done: boolean;
}

/** `null` means no plan file exists yet — "still planning", not "0 done". */
export interface BuildProgress {
  total: number;
  done: number;
  finished: boolean;
  current_task: PlanTaskRow | null;
  tasks: PlanTaskRow[];
}

export interface ProjectBuild {
  has_spec: boolean;
  has_plan: boolean;
  progress: BuildProgress | null;
}

/** Exactly what `repo_overview` computes — no second repository reader.
 * `exists: false` when there was no directory to walk. */
export interface ProjectRepo {
  exists: boolean;
  headline: string;
  body: string;
}

export interface ProjectDetail extends ProjectListItem {
  sessions: SessionRow[];
  runs: RunRow[];
  repo: ProjectRepo;
  build: ProjectBuild;
}

export async function listProjectViews(): Promise<ProjectListItem[]> {
  const body = await get<{ projects: ProjectListItem[]; taken_at: number }>(
    "/api/projects/view");
  return body.projects;
}

export async function getProjectDetail(name: string): Promise<ProjectDetail> {
  const body = await get<{ project: ProjectDetail }>(
    `/api/projects/view/${encodeURIComponent(name)}`);
  return body.project;
}

export type OpenTarget = "editor" | "terminal" | "browser";

/** Open a project's own directory. `path` must be one of the project's own
 * known directories — the server checks this itself, so a stale or
 * tampered selection fails closed rather than opening something else. */
export async function openProject(
  name: string, path: string, target: OpenTarget,
): Promise<boolean> {
  const res = await fetch("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path, target }),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { success: boolean };
  return body.success;
}

/**
 * The review surface (`/api/specs`).
 *
 * Everything below is written by a language model and read off someone's
 * disk: titles, section bodies, task names. It reaches the DOM through
 * `textContent` and the safe Markdown renderer, never `innerHTML`.
 *
 * `number` on a section is the number the USER SAYS. It is computed once, in
 * `specs.py`, and the same value reaches JARVIS through `review_document` —
 * so nothing on this side may ever renumber, reorder or filter sections.
 */

/** What a project needs from the user right now. */
export type ReviewState =
  /** Something is unapproved, or was revised after it was approved. */
  | "awaiting"
  /** Approved; the session has not written a plan yet. */
  | "planning"
  /** A plan with work left on it. */
  | "building"
  /** Every task ticked: finished work, waiting to be looked at. */
  | "review";

/** Whether this exact text has the user's yes. */
export type ApprovalState = "awaiting" | "approved" | "superseded";

export interface SpecApproval {
  state: ApprovalState;
  /** Epoch seconds; 0 when nobody has approved it. */
  approved_at: number | null;
  approved_by: string;
}

/** Task progress, read off a plan's `- [ ]` checkboxes. */
export interface PlanProgress {
  done: number;
  total: number;
  /** Title of the first unfinished task; "" when they are all done. */
  current: string;
  /** The SECTION number that task is, so the page can point at it. */
  current_section: number;
  steps_done: number;
  steps_total: number;
}

export interface SpecDocumentMeta {
  /** Project-relative, e.g. docs/superpowers/specs/2026-09-03-x-design.md */
  path: string;
  kind: "spec" | "plan";
  title: string;
  modified: number;
  sections: number;
  approval: SpecApproval;
  /** Plans only. */
  progress: PlanProgress | null;
}

export interface SpecProject {
  name: string;
  /** The directory this copy lives in. THE IDENTITY of the row: a project
   * with a Claude Code worktree appears under one name more than once. */
  path: string;
  /** Which copy this is ("worktree runs-dashboard"), or "" when the name
   * lives in exactly one place and needs no distinguishing. */
  where: string;
  state: ReviewState;
  documents: SpecDocumentMeta[];
  progress: PlanProgress | null;
  plan_path: string;
  /** Paths of the documents that need the user's eye. */
  awaiting: string[];
  modified: number;
}

/** One numbered, top-level section. `body` is raw Markdown. */
export interface SpecSection {
  number: number;
  title: string;
  level: number;
  body: string;
}

/**
 * One document, whole. Deliberately NOT an extension of `SpecDocumentMeta`:
 * in the list `sections` is a COUNT and here it is the sections themselves,
 * and a shape that quietly meant both would be the kind of ambiguity this
 * surface exists to remove.
 */
export interface SpecDocument {
  project: string;
  path: string;
  kind: "spec" | "plan";
  title: string;
  modified: number;
  approval: SpecApproval;
  /** Plans only. */
  progress: PlanProgress | null;
  /** Anything above section 1. */
  preamble: string;
  sections: SpecSection[];
}

export async function listSpecs(): Promise<SpecProject[]> {
  const body = await get<{ projects: SpecProject[] }>("/api/specs");
  return body.projects;
}

/**
 * One document out of one COPY of a project.
 *
 * `root` names which copy: a project with a Claude Code worktree appears
 * under one name in two directories, and the server accepts `root` only as
 * one of that project's own known directories.
 */
export async function getSpecDocument(
  project: string, path: string, root: string,
): Promise<SpecDocument> {
  return get<SpecDocument>(
    `/api/specs/doc?project=${encodeURIComponent(project)}`
    + `&root=${encodeURIComponent(root)}`
    + `&path=${encodeURIComponent(path)}`);
}

/**
 * Per-session usage (`/api/usage/sessions`), read off the CLI's own
 * transcripts by `usage_scan.py`.
 *
 * `/api/usage/limits` above says how much of the SUBSCRIPTION is gone. This
 * says who spent it. The two are separate calls on purpose: a 3-second cold
 * transcript scan must never be able to blank the limit gauges.
 *
 * Everything here is read off other people's transcripts — project names,
 * subagent prompts, model ids. All of it reaches the DOM through textContent.
 */

/** The four counts the CLI reports. They are not interchangeable: cache
 * reads are most of a long conversation's input. `total` is all four. */
export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

/** One subagent a conversation dispatched. */
export interface AgentUsage {
  agent_id: string;
  model: string;
  tokens: Tokens;
  turns: number;
  first_at: number | null;
  last_at: number | null;
  /** The brief it was launched with; "" when the line wasn't in the file. */
  prompt: string;
  /**
   * From the `agent-<id>.meta.json` sidecar the CLI writes at spawn — the
   * only place a subagent says what it IS. All four are "" / 0 for older
   * transcripts that have no sidecar: unknown, not "general-purpose".
   */
  agent_type: string;
  /** The one-line description the dispatch was given. Far better to read
   * than `prompt`, which is the whole brief. */
  description: string;
  parent_agent_id: string;
  /** 1 for an agent the conversation dispatched, 2+ for one dispatched by
   * another agent. 0 means no sidecar — unknown depth, not top level. */
  depth: number;
  /**
   * Its transcript was written within `active_within_sec`. This is a FILE
   * age, not a process check — there is no process to check — so the UI
   * says "active", never "running".
   */
  active: boolean;
}

export interface SessionUsage {
  session_id: string;
  cwd: string;
  project: string;
  /** What the conversation itself spent. */
  tokens: Tokens;
  /** What everything it dispatched spent. */
  agent_tokens: Tokens;
  total_tokens: Tokens;
  turns: number;
  /**
   * The LAST turn's carried context (input + cache), not the sum of every
   * turn — the sum reports a 200k window as several million. `null` when the
   * transcript holds no assistant turn at all: unknown, not zero.
   */
  context_tokens: number | null;
  first_at: number | null;
  last_at: number | null;
  active_agents: number;
  agents: AgentUsage[];
  models: { model: string; tokens: Tokens }[];
  /** JARVIS's own machinery (his brain, or a run he spawned). */
  own: boolean;
}

export interface DayUsage {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  tokens: Tokens;
}

export interface UsageSessions {
  /**
   * False when no transcript was read at all. The zeros beside it are the
   * arithmetic of an empty set, not a measurement — render the words, not
   * the numbers.
   */
  measured: boolean;
  scanned_at: number;
  active_within_sec: number;
  roots: string[];
  files: number;
  bytes_read: number;
  /** The user's work. JARVIS's own is in `own_totals`. */
  totals: Tokens;
  own_totals: Tokens;
  today: Tokens;
  session_count: number;
  own_session_count: number;
  project_count: number;
  active_agents: number;
  daily: DayUsage[];
  models: { model: string; tokens: Tokens }[];
  /**
   * A TRUNCATED list — `session_count` is the whole population. It carries
   * the union of two orderings, because two tabs read it: the most RECENT
   * conversations, for the Sessions tab, and the biggest SPENDERS, for the
   * Usage tab's ranking.
   */
  sessions: SessionUsage[];
  /**
   * How many of the machine's biggest spenders are guaranteed to be in
   * `sessions`. This is the licence for the word "smaller": a list ranked by
   * spend can only claim the rest are smaller as far as this number goes.
   */
  largest_listed: number;
  own_sessions: SessionUsage[];
}

export async function getUsageSessions(): Promise<UsageSessions> {
  return get<UsageSessions>("/api/usage/sessions");
}
