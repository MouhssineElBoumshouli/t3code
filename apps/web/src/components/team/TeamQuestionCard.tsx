/**
 * team-layer: a teammate's question ("Ask", team/PREVENTION_PLAN.md slice 3d).
 * They want their chat to change files this person holds; the answer is yes
 * or no, with an optional line. Shown on the chat that holds those files and
 * in the presence popover; answered from either, on any client.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TeamQuestionCard as TeamQuestionCardData } from "@t3tools/client-runtime/work-log/team-cards";
import type { EnvironmentId, TeamId } from "@t3tools/contracts";
import { CheckIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { teamFeed } from "~/state/teamFeed";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

const quotedPaths = (paths: ReadonlyArray<string>) => (
  <>
    {paths.map((path, index) => (
      <span key={path}>
        {index > 0 ? ", " : null}
        <code className="font-mono text-foreground/90">{path}</code>
      </span>
    ))}
  </>
);

/** Yes / No with an optional line; used by the chat card and the popover. */
export const TeamAnswerForm = memo(function TeamAnswerForm(props: {
  readonly environmentId: EnvironmentId;
  readonly teamId: TeamId;
  readonly questionId: string;
}) {
  const answer = useAtomCommand(teamFeed.answer, { reportFailure: false });
  const [line, setLine] = useState("");
  const [pending, setPending] = useState<"yes" | "no" | null>(null);

  const send = (yes: boolean) => {
    setPending(yes ? "yes" : "no");
    const text = line.trim();
    void answer({
      environmentId: props.environmentId,
      input: {
        teamId: props.teamId,
        questionId: props.questionId,
        yes,
        ...(text.length > 0 ? { text } : {}),
      },
    }).then((result) => {
      setPending(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Your answer was not sent",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        size="compact"
        className="min-w-40 flex-1"
        placeholder="Add a line (optional)"
        aria-label="A line with your answer (optional)"
        value={line}
        disabled={pending !== null}
        onValueChange={setLine}
      />
      <Button
        size="compact"
        variant="outline"
        disabled={pending !== null}
        onClick={() => send(true)}
      >
        {pending === "yes" ? "Sending…" : "Yes, go ahead"}
      </Button>
      <Button
        size="compact"
        variant="outline"
        disabled={pending !== null}
        onClick={() => send(false)}
      >
        {pending === "no" ? "Sending…" : "No"}
      </Button>
    </div>
  );
});

/** The question in the asker's words: who, which files, and their line. */
export function TeamQuestionText(props: {
  readonly name: string;
  readonly paths: ReadonlyArray<string>;
  readonly text: string | null;
  readonly askedAt: string;
}) {
  return (
    <>
      <p className="text-foreground">
        <span className="font-medium">{props.name}</span> asks to change {quotedPaths(props.paths)}
        <span className="text-muted-foreground"> · {formatRelativeTimeLabel(props.askedAt)}</span>
      </p>
      {props.text === null ? null : <p className="text-muted-foreground">"{props.text}"</p>}
    </>
  );
}

const CLOSED_WORDS = {
  yes: "You said yes",
  no: "You said no",
  withdrawn: "No longer needed",
} as const;

export const TeamQuestionCard = memo(function TeamQuestionCard(props: {
  readonly card: TeamQuestionCardData;
  readonly environmentId: EnvironmentId;
}) {
  const { card } = props;
  return (
    <section
      aria-label="A teammate's question"
      data-team-question
      className="rounded-lg border border-border bg-card text-xs"
    >
      <div className="flex items-start gap-2 px-3 pt-2 pb-1.5">
        <MessageCircleQuestionIcon
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0">
          <TeamQuestionText
            name={card.from.name}
            paths={card.paths}
            text={card.text}
            askedAt={card.askedAt}
          />
          <p className="text-muted-foreground">
            This chat holds them. Their chat waits for your answer.
          </p>
        </div>
      </div>
      <div className="border-t border-border/70 px-3 py-2">
        {card.closed === null ? (
          <TeamAnswerForm
            environmentId={props.environmentId}
            teamId={card.teamId}
            questionId={card.questionId}
          />
        ) : (
          <p className="flex items-center gap-1.5 text-foreground">
            {card.closed.outcome === "yes" ? (
              <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" />
            ) : (
              <XIcon aria-hidden className="size-3.5 text-muted-foreground" />
            )}
            {CLOSED_WORDS[card.closed.outcome]}
            {card.closed.text === null ? null : (
              <span className="text-muted-foreground">· "{card.closed.text}"</span>
            )}
          </p>
        )}
      </div>
    </section>
  );
});
