/**
 * team-layer: the warning card (team/UI_PLAN.md slice 3, PREVENTION_PLAN.md
 * slices 3a and 3c). In the agent's message, where it stopped before editing:
 * the planned files someone else holds, and the choices. The click goes to
 * the server, which answers the held `team_plan` call or starts a turn; the
 * choice then shows on the card. "Wait" shows while it waits and can be
 * stopped, which opens the card again; when the holder lets go, the server
 * continues the chat.
 */
import { planHolders } from "@t3tools/client-runtime/state/teamMarkers";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TeamChoiceCard as TeamChoiceCardData } from "@t3tools/client-runtime/work-log/team-cards";
import {
  type EnvironmentId,
  type TeamChoice,
  type TeamChooseAction,
  teamChoiceIsOpen,
} from "@t3tools/contracts";
import { CheckIcon, HourglassIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { toastManager } from "~/components/ui/toast";
import { teamFeed } from "~/state/teamFeed";
import { useAtomCommand } from "~/state/use-atom-command";

import { TeamHolderMarks, TeamHolderNames } from "./TeamHolderMarks";

const CHOICE_LABELS: Record<Exclude<TeamChoice, "wait">, string> = {
  anotherWay: "Find another way",
  goAnyway: "Go anyway",
};

/** A card for a change the turn already made (the guard's after-the-turn check). */
const EDITED_CHOICE_LABELS: Record<Exclude<TeamChoice, "wait">, string> = {
  anotherWay: "Undo it, find another way",
  goAnyway: "Keep the change",
};

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
  const open = teamChoiceIsOpen(card.made);
  const them = files.length === 1 ? "it" : "them";

  const onChoose = (choice: TeamChooseAction) => {
    setPending(choice);
    void choose({
      environmentId: props.environmentId,
      input: { threadId: card.threadId, choiceId: card.choiceId, choice },
    }).then((result) => {
      setPending(null);
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
            </div>
            {card.solo || card.edited === true ? null : (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="text-muted-foreground">Coming soon:</span>
                {[
                  `Build on top of ${names === null ? "their" : `${names}'s`} work`,
                  `Ask ${names ?? "them"}`,
                ].map((label) => (
                  <Button key={label} size="compact" variant="ghost-muted" disabled>
                    {label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : card.made?.wait === "waiting" ? (
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
        ) : card.made?.wait === "conflict" ? (
          <p className="flex items-center gap-1.5 text-foreground">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            {waitFor === "that chat" ? "That chat" : waitFor} let go, but this chat's copy could not
            be moved on top of their work: a conflict. Update it, then send a message.
          </p>
        ) : card.made?.wait === "done" ? (
          <p className="flex items-center gap-1.5 text-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
            Waited for {waitFor}
            <span className="text-muted-foreground">· the chat went on as a new message</span>
          </p>
        ) : card.made !== null && card.made.choice !== "wait" ? (
          <p className="flex items-center gap-1.5 text-foreground">
            <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
            You chose: {labels[card.made.choice]}
            <span className="text-muted-foreground">{DELIVERY_WORDS[card.made.delivery]}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
});
