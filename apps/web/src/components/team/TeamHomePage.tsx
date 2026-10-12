/**
 * team-layer: the Team home page, "Today" when solo (team/UI_PLAN.md slice 4,
 * DESIGN_DIRECTION.md Option C). Reached from the sidebar's icon row and the
 * command palette; it follows the project of the chat you came from.
 *
 * Everything on it comes from data the client already holds: the team feed
 * (pushed by the server) and the project's chat shells. The "since you were
 * last here" line is fixed when the page opens; nothing on it ticks.
 */
import {
  buildCatchUp,
  claimPathsInProject,
  type TeamHomeChat,
} from "@t3tools/client-runtime/state/teamHome";
import {
  findProjectTeam,
  holderHue,
  holderInitials,
  threadHolders,
} from "@t3tools/client-runtime/state/teamMarkers";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  TeamFeedTeam,
  TeamMember,
  TeamTask,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { HouseIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { useProject, useThreadShellsForProjectRefs } from "~/state/entities";
import { teamAwaitsUser, useTeamFeed, useTeamThreadCardsByThread } from "~/state/teamFeed";
import { formatDayAwareTimestamp, formatRelativeTimeLabel } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { TeamFace } from "./TeamHolderMarks";
import { TeamNotes } from "./TeamNotes";
import { syncLabel } from "./TeamPresenceChip";

const MAX_PATHS = 3;
const TASK_STATUS: Record<TeamTask["status"], string> = {
  todo: "to do",
  in_progress: "in progress",
  in_review: "in review",
  done: "done",
};

const lastVisitKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `t3code:team-home:last-visit:v1:${environmentId}:${projectId}`;

/** The previous visit to this project's page, read once; this visit is saved for the next. */
function useLastVisit(environmentId: EnvironmentId, projectId: ProjectId) {
  const key = lastVisitKey(environmentId, projectId);
  const [visit] = useState(() => {
    const now = new Date().toISOString();
    try {
      return { now, last: getLocalStorageItem(key, Schema.String) };
    } catch {
      return { now, last: null };
    }
  });
  useEffect(() => {
    try {
      setLocalStorageItem(key, visit.now, Schema.String);
    } catch {
      // A blocked storage only costs the next visit its "since" line.
    }
  }, [key, visit.now]);
  return visit;
}

const pathList = (paths: ReadonlyArray<string>) =>
  paths.length === 0
    ? null
    : `${paths.slice(0, MAX_PATHS).join(", ")}${paths.length > MAX_PATHS ? ` +${paths.length - MAX_PATHS}` : ""}`;

function Section(props: {
  readonly title: string;
  readonly aside?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 p-4">
      <h2 className="flex items-baseline gap-2 text-sm font-medium text-foreground">
        <span className="grow">{props.title}</span>
        {props.aside ? (
          <span className="text-xs font-normal text-muted-foreground">{props.aside}</span>
        ) : null}
      </h2>
      {props.children}
    </section>
  );
}

function Muted(props: { readonly children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{props.children}</p>;
}

/** Notes for the team, or to future you (UI_PLAN.md slice 4, part 2). */
function NotesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly team: TeamFeedTeam | null;
  readonly pathPrefix: string;
}) {
  return (
    <Section title="Notes">
      {props.team === null ? (
        <Muted>Notes appear once this project's state is open on the server.</Muted>
      ) : (
        <TeamNotes
          environmentId={props.environmentId}
          team={props.team}
          pathPrefix={props.pathPrefix}
        />
      )}
    </Section>
  );
}

export function TeamHomePage(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const project = useProject({ environmentId, projectId });
  const teams = useTeamFeed(environmentId);
  const projectTeam = useMemo(() => findProjectTeam(teams, projectId), [teams, projectId]);
  const team = projectTeam?.team ?? null;
  const pathPrefix = projectTeam?.pathPrefix ?? "";
  const solo = team === null || team.solo;

  const projectRefs = useMemo(() => [{ environmentId, projectId }], [environmentId, projectId]);
  const shells = useThreadShellsForProjectRefs(projectRefs);
  const cardsByThread = useTeamThreadCardsByThread(environmentId);
  const chats = useMemo(
    () =>
      shells
        .filter((shell) => shell.archivedAt === null)
        .map((shell) => ({
          shell,
          chat: {
            key: `${shell.environmentId}/${shell.id}`,
            title: shell.title,
            working: threadRuntimeIsActive(shell.runtime),
            awaitsYou:
              shell.hasPendingApprovals ||
              shell.hasPendingUserInput ||
              teamAwaitsUser(cardsByThread.get(shell.id), shell.latestRun?.runId ?? null),
            completedAt: shell.latestRun?.completedAt ?? null,
          } satisfies TeamHomeChat,
        })),
    [shells, cardsByThread],
  );

  const visit = useLastVisit(environmentId, projectId);
  const catchUp = useMemo(
    () =>
      buildCatchUp({
        team,
        pathPrefix,
        chats: chats.map((entry) => entry.chat),
        lastVisitAt: visit.last,
        now: visit.now,
      }),
    [team, pathPrefix, chats, visit],
  );

  const openChat = (threadId: string) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });

  const title = solo ? "Today" : "Team home";
  const sync = team === null ? null : syncLabel(team.sync);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <span className="flex items-center gap-2 text-sm font-medium">
            {solo ? <HouseIcon className="size-4" /> : <UsersIcon className="size-4" />}
            {title}
          </span>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" data-team-home={solo ? "solo" : "team"}>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">
                {solo ? "Today" : (team?.name ?? project?.title)}
              </h1>
              <span className="text-sm text-muted-foreground">{project?.title}</span>
              {solo ? (
                <Badge variant="outline">just you</Badge>
              ) : sync ? (
                <Badge variant={sync.warn ? "warning" : "success"}>{sync.text}</Badge>
              ) : null}
            </div>

            <div
              data-team-catch-up
              className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3 text-sm"
            >
              <span className="font-medium">
                {catchUp.firstVisit
                  ? "In the last day"
                  : `Since ${formatDayAwareTimestamp(catchUp.since, timestampFormat, Date.parse(visit.now))}`}
              </span>
              <span className="text-muted-foreground"> · </span>
              {catchUp.sentences.length === 0 ? (
                <span className="text-muted-foreground">Nothing new.</span>
              ) : (
                <span>{catchUp.sentences.join(" ")}</span>
              )}
            </div>

            {solo ? (
              <SoloChats chats={chats} team={team} pathPrefix={pathPrefix} openChat={openChat} />
            ) : (
              <TeamPeople team={team} pathPrefix={pathPrefix} />
            )}

            <div className="grid gap-4 md:grid-cols-2">
              {solo ? null : <TeamTasks team={team} />}
              {solo ? null : <TeamHandoffs team={team} />}
              <NotesSection environmentId={environmentId} team={team} pathPrefix={pathPrefix} />
              {solo ? <MakeTeamSection /> : null}
            </div>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

const memberName = (team: TeamFeedTeam, memberId: string) =>
  team.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;

function TeamPeople(props: { readonly team: TeamFeedTeam; readonly pathPrefix: string }) {
  const { team } = props;
  // You first, then teammates by who was around last.
  const people = useMemo(
    () =>
      [...team.members].sort((a, b) =>
        a.memberId === team.me
          ? -1
          : b.memberId === team.me
            ? 1
            : Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt),
      ),
    [team],
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {people.map((member) => (
        <PersonCard
          key={member.memberId}
          team={team}
          member={member}
          pathPrefix={props.pathPrefix}
        />
      ))}
    </div>
  );
}

function PersonCard(props: {
  readonly team: TeamFeedTeam;
  readonly member: TeamMember;
  readonly pathPrefix: string;
}) {
  const { team, member } = props;
  const isMe = member.memberId === team.me;
  const claims = team.claims.filter((claim) => claim.memberId === member.memberId);
  const paths = [
    ...new Set(claims.flatMap((claim) => claimPathsInProject(claim, props.pathPrefix))),
  ];
  const notes = claims.flatMap((claim) => (claim.note === null ? [] : [claim.note]));
  const tasks = team.tasks.filter(
    (task) => task.ownerMemberId === member.memberId && task.status !== "todo",
  );
  const ownBranch = claims.some((claim) => claim.branch !== undefined);
  const latest = team.handoffs.find((handoff) => handoff.memberId === member.memberId);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border p-3 text-xs",
        ownBranch ? "border-warning/40" : "border-border/70",
      )}
    >
      <div className="flex items-center gap-2">
        <TeamFace
          initials={holderInitials(member.displayName)}
          hue={holderHue(`member:${member.memberId}`)}
          size="md"
        />
        <span className="grow truncate text-sm font-medium">{member.displayName}</span>
        <span className="shrink-0 text-muted-foreground">
          {isMe ? "you" : `seen ${formatRelativeTimeLabel(member.lastSeenAt)}`}
        </span>
      </div>
      {tasks.map((task) => (
        <div key={task.taskId} className="truncate">
          {task.title} <span className="text-muted-foreground">· {TASK_STATUS[task.status]}</span>
        </div>
      ))}
      {notes.length > 0 ? <div className="truncate text-muted-foreground">{notes[0]}</div> : null}
      <div className="truncate font-mono text-2xs text-muted-foreground">
        {pathList(paths) === null ? "holds nothing" : `holds ${pathList(paths)}`}
      </div>
      {ownBranch ? <div className="text-warning-foreground">own branch, not merged yet</div> : null}
      {latest ? (
        <div className="truncate text-muted-foreground">
          Handoff {formatRelativeTimeLabel(latest.createdAt)}: {latest.headline}
        </div>
      ) : null}
    </div>
  );
}

function TeamTasks(props: { readonly team: TeamFeedTeam }) {
  const { team } = props;
  return (
    <Section title="Tasks" aside={`${team.tasks.length} open`}>
      {team.tasks.length === 0 ? (
        <Muted>No open tasks. Agents add them with team_task.</Muted>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {team.tasks.map((task) => (
            <li key={task.taskId} className="flex items-baseline gap-2">
              <span className="min-w-0 grow truncate">{task.title}</span>
              <span className="shrink-0 text-muted-foreground">
                {TASK_STATUS[task.status]}
                {task.ownerMemberId === null ? "" : ` · ${memberName(team, task.ownerMemberId)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function TeamHandoffs(props: { readonly team: TeamFeedTeam }) {
  const { team } = props;
  return (
    <Section title="Recent handoffs">
      {team.handoffs.length === 0 ? (
        <Muted>No handoffs yet. A chat writes one when it finishes its part.</Muted>
      ) : (
        <ul className="flex flex-col gap-1.5 text-xs">
          {team.handoffs.map((handoff) => (
            <li key={handoff.handoffId}>
              <span className="font-medium">{memberName(team, handoff.memberId)}</span>
              <span className="text-muted-foreground">
                {" "}
                · {formatRelativeTimeLabel(handoff.createdAt)}:{" "}
              </span>
              {handoff.headline}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SoloChats(props: {
  readonly chats: ReadonlyArray<{
    readonly shell: EnvironmentThreadShell;
    readonly chat: TeamHomeChat;
  }>;
  readonly team: TeamFeedTeam | null;
  readonly pathPrefix: string;
  readonly openChat: (threadId: string) => void;
}) {
  const { team } = props;
  const titles = useMemo(
    () => new Map(props.chats.map((entry) => [entry.chat.key, entry.chat.title])),
    [props.chats],
  );
  // Chats that are running, wait for you, or hold files.
  const shown = props.chats.filter(
    (entry) =>
      entry.chat.working ||
      entry.chat.awaitsYou ||
      team?.claims.some(
        (claim) => `${claim.thread.environmentId}/${claim.thread.threadId}` === entry.chat.key,
      ),
  );
  if (shown.length === 0) {
    return <Muted>No chats running in this project.</Muted>;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map(({ shell, chat }) => {
        const claims =
          team?.claims.filter(
            (claim) => `${claim.thread.environmentId}/${claim.thread.threadId}` === chat.key,
          ) ?? [];
        const paths = [
          ...new Set(claims.flatMap((claim) => claimPathsInProject(claim, props.pathPrefix))),
        ];
        const overlaps =
          team === null
            ? []
            : threadHolders(team, {
                environmentId: shell.environmentId,
                threadId: shell.id,
              }).flatMap((holder) =>
                holder.kind === "chat"
                  ? [titles.get(`${holder.environmentId}/${holder.threadId}`) ?? "another chat"]
                  : [],
              );
        const status = chat.awaitsYou ? "waiting for you" : chat.working ? "working" : "idle";
        return (
          <button
            key={chat.key}
            type="button"
            onClick={() => props.openChat(shell.id)}
            className={cn(
              "flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl border p-3 text-left text-xs transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              overlaps.length > 0 || chat.awaitsYou ? "border-warning/40" : "border-border/70",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  chat.awaitsYou
                    ? "bg-warning"
                    : chat.working
                      ? "bg-success"
                      : "bg-muted-foreground/40",
                )}
              />
              <span className="grow truncate text-sm font-medium">{chat.title}</span>
              <span
                className={cn(
                  "shrink-0",
                  chat.awaitsYou ? "text-warning-foreground" : "text-muted-foreground",
                )}
              >
                {status}
              </span>
            </div>
            <div className="truncate font-mono text-2xs text-muted-foreground">
              {pathList(paths) === null ? "holds nothing" : `holds ${pathList(paths)}`}
            </div>
            {overlaps.length > 0 ? (
              <div className="truncate text-warning-foreground">
                Overlaps {overlaps.map((title) => `"${title}"`).join(", ")}
              </div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Explains what turning the project into a team project does; the action comes later. */
function MakeTeamSection() {
  return (
    <Section title="Working with others?">
      <Muted>
        Share what your chats hold, tasks and handoffs with teammates through the project's GitHub
        repo. Nothing is shared until you do.
      </Muted>
      <Popover>
        <div>
          <PopoverTrigger
            render={
              <Button variant="outline" size="compact">
                <UsersIcon />
                Make this a team project
              </Button>
            }
          />
        </div>
        <PopoverPopup side="top" align="start" width="md" padding="compact">
          <PopoverTitle>What this will do</PopoverTitle>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
            <li>
              Add a small <span className="font-mono">.team/</span> folder to the repo for you to
              commit, and keep the team's state on the repo's remote.
            </li>
            <li>
              Teammates with push access join by pulling it and opening the project in T3 Code.
            </li>
            <li>
              They see which files each chat holds, the tasks and the handoff notes, and agents warn
              before editing what someone else holds.
            </li>
            <li>Use a private repo: anyone who can read it can read the team state.</li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Not available from here yet. Today it is done with{" "}
            <span className="font-mono">t3 team init</span> in the project folder.
          </p>
        </PopoverPopup>
      </Popover>
    </Section>
  );
}
