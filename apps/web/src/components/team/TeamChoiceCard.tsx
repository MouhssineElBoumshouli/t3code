/**
 * team-layer: the warning card (team/UI_PLAN.md slice 3, PREVENTION_PLAN.md
 * slices 3a, 3c and 3d). In the agent's message, where it stopped before
 * editing: the planned files someone else holds, and the choices. The click
 * goes to the server, which answers the held `team_plan` call or starts a
 * turn; the choice then shows on the card. "Wait" shows while it waits and
 * can be stopped, which opens the card again; when the holder lets go, the
 * server continues the chat. Team only: "Ask" sends a question (the other
 * choices stay open until the answer; a no opens the card without Ask), and
 * "Build on top" moves this chat's copy onto the holder's pushed branch.
 */
import { findProjectTeam, planHolders } from "@t3tools/client-runtime/state/teamMarkers";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TeamChoiceCard as TeamChoiceCardData } from "@t3tools/client-runtime/work-log/team-cards";
import {
  buildOnTopClaim,
  type EnvironmentId,
  type TeamChooseAction,
  teamChoiceIsOpen,
} from "@t3tools/contracts";
import {
  CheckIcon,
  GitBranchIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { toastManager } from "~/components/ui/toast";
import { useThreadShell } from "~/state/entities";
import { teamFeed, useTeamFeed } from "~/state/teamFeed";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { TeamHolderMarks, TeamHolderNames } from "./TeamHolderMarks";

const CHOICE_LABELS = {
  anotherWay: "Find another way",
  goAnyway: "Go anyway",
} as const;

/** A card for a change the turn already made (the guard's after-the-turn check). */
const EDITED_CHOICE_LABELS = {
  anotherWay: "Undo it, find another way",
  goAnyway: "Keep the change",
} as const;

const DELIVERY_WORDS = {
  held: "· sent to the agent",
  turn: "· sent as a new message",
  none: "· the change stays",
} as const;

/** "Omar", "Sara and Omar"; null when only the user's own chats hold the files. */
const memberNames = (card: TeamChoiceCardData) => {
  const names = [
    ...new Set(
      card.files.flatMap((file) =>
        file.holders.flatMap((holder) => (holder.kind === "member" ? [holder.name] : [])),
      ),
    ),
  ];
  if (names.length === 0) return null;
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

export const TeamChoiceCard = memo(function TeamChoiceCard(props: {
  readonly card: TeamChoiceCardData;
  readonly environmentId: EnvironmentId;
  readonly resolvedTheme: "light" | "dark";
}) {
  const { card } = props;
  const choose = useAtomCommand(teamFeed.choose, { reportFailure: false });
  const [pending, setPending] = useState<TeamChooseAction | null>(null);
  const [asking, setAsking] = useState(false);
  const [askLine, setAskLine] = useState("");
  const files = useMemo(
    () => card.files.map((file) => ({ path: file.path, holders: planHolders(file.holders) })),
    [card.files],
  );
  const names = card.solo ? null : memberNames(card);
  const fileWords = files.length === 1 ? "a file" : `${files.length} files`;
  const where = card.edited === true ? "this chat changed" : "in this plan";
  const title =
    names === null
      ? `Another chat holds ${fileWords} ${where}`
      : `${names} ${names.includes(" and ") ? "hold" : "holds"} ${fileWords} ${where}`;
  const waitFor = names ?? "that chat";
  const labels = card.edited === true ? EDITED_CHOICE_LABELS : CHOICE_LABELS;
  const made = card.made;
  const open = teamChoiceIsOpen(made);
  const them = files.length === 1 ? "it" : "them";
  // Team only, before the change: "Ask" and "Build on top" need a teammate.
  const teamChoices = !card.solo && card.edited !== true && names !== null;

  // "Build on top" needs the holder's branch pushed (from the team feed) and a copy of this chat's own.
  const shell = useThreadShell(
    teamChoices ? { environmentId: props.environmentId, threadId: card.threadId } : null,
  );
  const teams = useTeamFeed(teamChoices ? props.environmentId : null);
  const pushed = useMemo(() => {
    const team = findProjectTeam(teams, shell?.projectId ?? null)?.team;
    return team === undefined ? undefined : buildOnTopClaim(team.claims, card.files);
  }, [teams, shell?.projectId, card.files]);
  const buildBlocked =
    shell !== null && shell.worktreePath === null
      ? "this chat has no copy of its own"
      : pushed === undefined
        ? "not pushed yet"
        : null;

  const onChoose = (choice: TeamChooseAction, text?: string) => {
    setPending(choice);
    void choose({
      environmentId: props.environmentId,
      input: {
        threadId: card.threadId,
        choiceId: card.choiceId,
        choice,
        ...(text !== undefined && text.trim().length > 0 ? { text: text.trim() } : {}),
      },
    }).then((result) => {
      setPending(null);
      if (result._tag === "Success" && choice === "ask") setAsking(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Your choice was not sent",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    });
  };

  const askedLine =
    made?.ask === "asked" ? (
      <p className="flex min-w-0 items-center gap-1.5 text-foreground">
        <MessageCircleQuestionIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        Asked {waitFor}
        {made.askedAt === undefined ? null : ` ${formatRelativeTimeLabel(made.askedAt)}`}
        <span className="text-muted-foreground">
          · the answer comes here; you can still choose below
        </span>
      </p>
    ) : made?.ask === "declined" && made.answer !== undefined ? (
      <p className="flex min-w-0 items-center gap-1.5 text-foreground">
        <XIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {made.answer.by} said no
        {made.answer.text === null ? null : (
          <span className="text-muted-foreground">· "{made.answer.text}"</span>
        )}
      </p>
    ) : null;

  return (
    <section
      aria-label="Files held by others"
      data-team-choice
      className="rounded-lg border border-warning/32 bg-warning-surface text-xs"
    >
      <div className="px-3 pt-2 pb-1">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-muted-foreground">
          {card.edited === true
            ? open
              ? "This chat changed it without planning it first. Choose what happens to the change."
              : "This chat changed it without planning it first."
            : open
              ? "The agent stopped before editing. Choose how it goes on."
              : "The agent stopped before editing."}
        </p>
      </div>
      <ul className="pb-1.5">
        {files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-center gap-2 px-3 py-0.5">
            <PierreEntryIcon
              pathValue={file.path}
              kind="file"
              theme={props.resolvedTheme}
              className="size-3.5 shrink-0 text-muted-foreground/70"
            />
            <span className="flex min-w-0 font-mono text-foreground/85">
              <MiddleTruncate value={file.path} />
            </span>
            <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 text-muted-foreground">
              <TeamHolderMarks holders={file.holders} />
              <span className="truncate">
                held by <TeamHolderNames holders={file.holders} />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-warning/20 px-3 py-2">
        {open ? (
          <div className="flex flex-col gap-1.5">
            {askedLine}
            <div className="flex flex-wrap gap-1.5">
              {(["anotherWay", "goAnyway"] as const).map((choice) => (
                <Button
                  key={choice}
                  size="compact"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => onChoose(choice)}
                >
                  {pending === choice ? "Sending…" : labels[choice]}
                </Button>
              ))}
              {card.edited === true ? null : (
                <Button
                  size="compact"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => onChoose("wait")}
                >
                  {pending === "wait" ? "Sending…" : `Wait for ${waitFor}`}
                </Button>
              )}
              {teamChoices ? (
                <Button
                  size="compact"
                  variant="outline"
                  disabled={pending !== null || buildBlocked !== null}
                  title={buildBlocked ?? `Move this chat onto ${pushed?.branch ?? "their branch"}`}
                  onClick={() => onChoose("buildOnTop")}
                >
                  {pending === "buildOnTop"
                    ? "Moving…"
                    : `Build on top of ${names}'s work${buildBlocked === null ? "" : ` · ${buildBlocked}`}`}
                </Button>
              ) : null}
              {teamChoices && made?.ask === undefined && !asking ? (
                <Button
                  size="compact"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => setAsking(true)}
                >
                  Ask {names}
                </Button>
              ) : null}
            </div>
            {asking && made?.ask === undefined ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  size="compact"
                  className="min-w-40 flex-1"
                  placeholder={`A line for ${names} (optional)`}
                  aria-label={`A line for ${names} (optional)`}
                  value={askLine}
                  disabled={pending !== null}
                  onValueChange={setAskLine}
                />
                <Button
                  size="compact"
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => onChoose("ask", askLine)}
                >
                  {pending === "ask" ? "Sending…" : "Send question"}
                </Button>
                <Button
                  size="compact"
                  variant="ghost-muted"
                  disabled={pending !== null}
                  onClick={() => setAsking(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
          </div>
        ) : made?.wait === "waiting" ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <p className="flex min-w-0 items-center gap-1.5 text-foreground">
              <HourglassIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              Waiting for {waitFor} to let go of {them}
              <span className="text-muted-foreground">· this chat goes on by itself then</span>
            </p>
            <Button
              size="compact"
              variant="outline"
              disabled={pending !== null}
              onClick={() => onChoose("cancelWait")}
            >
              {pending === "cancelWait" ? "Sending…" : "Stop waiting"}
            </Button>
          </div>
        ) : made?.wait === "conflict" ? (
          <p className="flex items-center gap-1.5 text-foreground">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            {waitFor === "that chat" ? "That chat" : waitFor} let go, but this chat's copy could not
            be moved on top of their work: a conflict. Update it, then send a message.
          </p>
        ) : made?.wait === "done" ? (
          <p className="flex items-center gap-1.5 text-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
            Waited for {waitFor}
            <span className="text-muted-foreground">· the chat went on as a new message</span>
          </p>
        ) : made?.choice === "buildOnTop" && made.onTopOf !== undefined ? (
          <p className="flex min-w-0 items-center gap-1.5 text-foreground">
            <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            Built on top of {made.onTopOf.name}'s work
            <span className="truncate text-muted-foreground">
              · on <code className="font-mono">{made.onTopOf.branch}</code>{" "}
              {DELIVERY_WORDS[made.delivery]}
            </span>
          </p>
        ) : made?.choice === "goAnyway" && made.answer?.yes === true ? (
          <p className="flex min-w-0 items-center gap-1.5 text-foreground">
            <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {made.answer.by} said yes: go anyway, agreed
            <span className="truncate text-muted-foreground">
              {made.answer.text === null ? "" : `· "${made.answer.text}" `}
              {DELIVERY_WORDS[made.delivery]}
            </span>
          </p>
        ) : made !== null && (made.choice === "anotherWay" || made.choice === "goAnyway") ? (
          <p className="flex items-center gap-1.5 text-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
            You chose: {labels[made.choice]}
            <span className="text-muted-foreground">{DELIVERY_WORDS[made.delivery]}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
});
