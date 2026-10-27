/**
 * Reopen a finished scheduled run's agent conversation in a new tab.
 *
 * The launch copies History's Resume (`ipc/sessions.ts`): the harness's own
 * `nativeConversationResume` projection plus an interactive terminal, with no
 * prompt sent. The schedule's persona is deliberately not reapplied: its
 * `initialPrompt` would be typed into the resumed conversation, a persona pinned
 * to an unattended profile conflicts with the resume projection, and the
 * conversation history already carries the earlier context. The old pty id is
 * never reused (a new tab always gets a fresh one), so the reopened tab is not a
 * run: it cannot receive the old run's report or finish, and does not count for
 * overlap or the scheduled-run cap, which only match a run's `sessionId`.
 *
 * Main owns every decision (Rules 1 and 2): the renderer sends only a schedule
 * id and an optional run id; the project, folder, harness and conversation id
 * are resolved here, and the id is validated because schedule files are editable.
 * Only an id the run recorded itself is used (minted at launch, or detected while
 * the run was live). Nothing is guessed afterwards: a folder-and-time lookup days
 * later can pick a newer conversation in the same folder and reopen the wrong one.
 * Every host service is injected so the logic is testable without the host.
 */
import type { CreateTerminalRequest, Project, Result, ScheduledTask, ScheduleRun, TerminalSession } from '@zana-ai/zcc-domain/product';
import { latestResumableRun, resumableRun } from '@zana-ai/zcc-domain/schedule-health';
import type { NativeConversationResume } from '@zana-ai/zcc-host-daemon/harness/registration';

export interface ResumeRunInput { scheduleId: string; runId?: string }
export interface ResumeRunValue { session: TerminalSession; reused: boolean }

interface Registration {
  nativeConversationResume?: (id: string) => NativeConversationResume | undefined;
  nativeConversationId?: (session: TerminalSession) => string | undefined;
}

export interface ResumeRunDeps {
  getTask: (scheduleId: string) => ScheduledTask | undefined;
  listProjects: () => Project[];
  /** Live (not exited) sessions of a project. */
  listLiveSessions: (projectId: string) => TerminalSession[];
  createInteractiveTerminal: (req: CreateTerminalRequest) => Promise<Result<TerminalSession>>;
  registrationFor: (profile: string) => Registration | undefined;
  realpath: (path: string) => string;
}

const fail = (code: string, message: string): Result<ResumeRunValue> => ({ ok: false, code, message });
const NO_CONVERSATION = "This run didn't record a conversation to reopen";
const UNSUPPORTED = "This agent can't reopen a past conversation";

/**
 * Opens still waiting for their terminal, by conversation id. Two clicks (or two
 * windows) that both pass the live-tab check before either tab exists join the
 * same open instead of starting two agents on one conversation.
 */
const opening = new Map<string, Promise<Result<ResumeRunValue>>>();

export async function resumeScheduledRun(input: ResumeRunInput, deps: ResumeRunDeps): Promise<Result<ResumeRunValue>> {
  const task = deps.getTask(input.scheduleId);
  if (!task) return fail('NOT_FOUND', 'This schedule is no longer available');

  const runs = task.status?.runs ?? [];
  let run: ScheduleRun | undefined;
  if (input.runId !== undefined) {
    run = runs.find((candidate) => candidate.id === input.runId);
    if (!run) return fail('RUN_NOT_FOUND', "This run is no longer in the schedule's history");
  } else {
    run = latestResumableRun(runs);
  }
  // One rule for "latest" and an explicit run: launched, not a Squad run, valid recorded id.
  if (!run || !resumableRun(run)) return fail('NO_CONVERSATION', NO_CONVERSATION);
  const conversation = run.conversation!;
  const id = conversation.id!;

  const project = deps.listProjects().find((candidate) => candidate.id === task.projectId);
  if (!project) return fail('PROJECT_MISSING', 'The project for this schedule is no longer registered');
  let cwd: string | undefined;
  if (!project.remote) {
    try { cwd = deps.realpath(project.path); }
    catch { return fail('PROJECT_MISSING', 'The project folder for this schedule is missing'); }
    // The recorded folder comes from an editable file, and a global schedule can move to
    // another project: reopen only in the folder the conversation was recorded in (Rule 2).
    let recorded: string | undefined;
    try { recorded = deps.realpath(conversation.cwd); } catch { recorded = undefined; }
    if (recorded !== cwd) {
      return fail('CONVERSATION_MOVED', "This run's conversation was recorded in another folder, so it can't be reopened here");
    }
  }

  const registration = deps.registrationFor(conversation.profile);
  if (!registration?.nativeConversationResume) return fail('UNSUPPORTED', UNSUPPORTED);

  const live = deps.listLiveSessions(project.id);
  const ownTab = run.sessionId ? live.find((session) => session.id === run.sessionId) : undefined;
  if (ownTab) return { ok: true, value: { session: ownTab, reused: true } };
  const sameConversation = live.find((session) => deps.registrationFor(session.profile)?.nativeConversationId?.(session) === id);
  if (sameConversation) return { ok: true, value: { session: sameConversation, reused: true } };

  const pending = opening.get(id);
  if (pending) {
    const joined = await pending;
    return joined.ok ? { ok: true, value: { session: joined.value.session, reused: true } } : joined;
  }
  const resume = registration.nativeConversationResume(id);
  if (!resume) return fail('UNSUPPORTED', UNSUPPORTED);
  const open = (async (): Promise<Result<ResumeRunValue>> => {
    const created = await deps.createInteractiveTerminal({
      projectId: project.id,
      cwd,
      cols: 80,
      rows: 24,
      title: `↺ ${task.name}`,
      ...resume
    } as CreateTerminalRequest);
    return created.ok ? { ok: true, value: { session: created.value, reused: false } } : created;
  })();
  opening.set(id, open);
  try { return await open; }
  finally { opening.delete(id); }
}
