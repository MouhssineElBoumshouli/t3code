/**
 * team-layer: merging help (team/MERGE_HELP_PLAN.md sections 3 and 5). The
 * server's merge checks as lines: fixes under way first, then clashes and
 * files to regenerate, then clean pairs where both sides changed the same
 * file; other clean pairs fold into one line that opens on click. A clash
 * has "Fix it"; a fix whose turn ended has Approve and Undo. A pair that
 * clashes or overlaps says which side to merge first (section 4); a clean
 * overlap with the base, or with the chat that goes first, offers an update
 * (a merge into the chat's copy), and an update that stops on a conflict says
 * so on the line and offers "Fix it". A clean pair offers "Check now" (the
 * combined check); its result shows under the line, with "Fix it" for new
 * errors and "Update anyway". A fix's line shows the check on its result
 * when the server ran one. Used by
 * Team home / Today's "Merging" section and the presence popover. Times are
 * worded when drawn; nothing ticks.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  combinedCheckOffered,
  combinedSentence,
  fixCheckSentence,
  fixIsForPair,
  foldedMergeLine,
  foldMergePairs,
  mergeFixBlocked,
  mergeFixSentence,
  mergeOrderSentence,
  mergePairPending,
  mergePairSentence,
  type MergeUpdateOffer,
  mergeUpdateOffer,
  mergeUpdateStoppedSentence,
  projectMergeFixes,
  projectMergePairs,
} from "@t3tools/client-runtime/state/teamMerging";
import type {
  EnvironmentId,
  ProjectId,
  TeamFeedTeam,
  TeamMergeFix,
  TeamMergeFixInput,
  TeamMergeOther,
  TeamMergePair,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { teamFeed } from "~/state/teamFeed";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

/** A pair's identity in a list: its chat and what it merges with. */
export const mergePairKey = (pair: Pick<TeamMergePair, "mine" | "other">) =>
  `${pair.mine.thread.threadId}|${
    pair.other._tag === "branch"
      ? `${pair.other.memberId}/${pair.other.branch}`
      : pair.other._tag === "chat"
        ? pair.other.thread.threadId
        : pair.other.branch
  }`;

/** Text and `code` parts, each with where it starts (its key). */
function codeParts(text: string) {
  const parts: Array<{ text: string; code: boolean; start: number }> = [];
  let start = 0;
  for (const [index, part] of text.split("`").entries()) {
    parts.push({ text: part, code: index % 2 === 1, start });
    start += part.length + 1;
  }
  return parts;
}

/** A sentence with `code` spans. */
export function MergeSentence(props: { readonly text: string }) {
  const parts = codeParts(props.text);
  return (
    <>
      {parts.map((part) =>
        part.code ? (
          <code key={part.start} className="font-mono text-2xs">
            {part.text}
          </code>
        ) : (
          <Fragment key={part.start}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * One pair: a dot by status, the sentence, when it was checked, and an action.
 * `updateStopped`: an update of this pair stopped on a conflict, said instead of "merge cleanly".
 */
export function MergePairLine(props: {
  readonly team: TeamFeedTeam;
  readonly pair: TeamMergePair;
  readonly pathPrefix: string;
  readonly updateStopped?: boolean;
  readonly action?: ReactNode;
}) {
  const { team, pair } = props;
  const pending = mergePairPending(team, pair);
  const order = mergeOrderSentence(team, pair);
  const combined = combinedSentence(team, pair, props.pathPrefix);
  return (
    <li className="flex items-start gap-2 text-xs" data-team-merge={pair.status}>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          pair.status === "clash" || props.updateStopped
            ? "bg-warning"
            : pair.status === "regenerate"
              ? "bg-muted-foreground"
              : "bg-success",
        )}
      />
      <span className="min-w-0">
        <MergeSentence
          text={
            props.updateStopped
              ? mergeUpdateStoppedSentence(team, pair)
              : mergePairSentence(team, pair, props.pathPrefix)
          }
        />
        <span className="text-muted-foreground">
          {" "}
          · {pending ?? `checked ${formatRelativeTimeLabel(pair.checkedAt)}`}
        </span>
        {order === null ? null : (
          <span className="block text-muted-foreground">
            <MergeSentence text={order} />
          </span>
        )}
        {combined === null ? null : (
          <span
            className={cn(
              "block",
              pair.combined?.status === "broken" ? "text-foreground" : "text-muted-foreground",
            )}
            data-team-combined={pair.combined?.status}
          >
            <MergeSentence text={combined} />
            {pair.combined?.status === "running"
              ? null
              : ` · checked ${formatRelativeTimeLabel(pair.combined!.checkedAt)}`}
          </span>
        )}
        {props.action}
      </span>
    </li>
  );
}

/**
 * "Fix it", Update, Approve and Undo, one at a time; a failure, where the
 * merge went, and how an update ended, as a toast. `onUpdateConflict` hears
 * an update that stopped on a conflict.
 */
function useMergeFixAction(environmentId: EnvironmentId, onUpdateConflict?: () => void) {
  const mergeFix = useAtomCommand(teamFeed.mergeFix, { reportFailure: false });
  const allowed = useAtomValue(teamFeed.mergeFix.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const act = useCallback(
    (input: TeamMergeFixInput, failedTitle: string) => {
      setPending(true);
      void mergeFix({ environmentId, input }).then((result) => {
        setPending(false);
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: failedTitle,
            description: error instanceof Error ? error.message : "Try again.",
          });
          return;
        }
        const outcome = result.value;
        if (input._tag === "update") {
          if (outcome.update === "conflict") onUpdateConflict?.();
          toastManager.add(
            outcome.update === "conflict"
              ? {
                  type: "warning",
                  title: "Not updated: Git stopped on a conflict",
                  description: outcome.detail ?? "Use Fix it to merge instead.",
                }
              : outcome.update === "checked"
                ? {
                    type: "warning",
                    title: "Not updated yet",
                    description: outcome.detail ?? "See the combined check on the line.",
                  }
                : { type: "success", title: "Copy updated" },
          );
          return;
        }
        if (input._tag !== "approve") return;
        toastManager.add(
          outcome.push === "failed"
            ? {
                type: "warning",
                title: "Merge committed, but the push failed",
                description: outcome.detail ?? "Push it from the chat.",
              }
            : {
                type: "success",
                title:
                  outcome.push === "pushed"
                    ? "Merge committed and pushed"
                    : "Merge committed (the branch is not pushed)",
              },
        );
      });
    },
    [mergeFix, environmentId, onUpdateConflict],
  );
  return { act, pending, allowed };
}

/**
 * A fix under way: what it merges, then Open chat; Undo while the agent waits
 * for an answer; Approve and Undo once its turn ended.
 */
function MergeFixLine(props: {
  readonly environmentId: EnvironmentId;
  readonly team: TeamFeedTeam;
  readonly fix: TeamMergeFix;
  readonly pathPrefix: string;
}) {
  const { fix } = props;
  const navigate = useNavigate();
  const { act, pending, allowed } = useMergeFixAction(props.environmentId);
  const threadId = fix.mine.thread.threadId;
  const check = fixCheckSentence(props.team, fix, props.pathPrefix);
  return (
    <li className="flex items-start gap-2 text-xs" data-team-merge-fix={fix.status}>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          fix.status === "ready"
            ? "bg-info"
            : fix.status === "asking"
              ? "bg-warning"
              : "bg-muted-foreground",
        )}
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span>
          <MergeSentence text={mergeFixSentence(props.team, fix, props.pathPrefix)} />
          {fix.savedWork ? (
            <span className="text-muted-foreground">
              {" "}
              · its uncommitted work was committed first
            </span>
          ) : null}
          {check === null ? null : (
            <span
              className={cn(
                "block",
                fix.check?.status === "broken" ? "text-foreground" : "text-muted-foreground",
              )}
              data-team-fix-check={fix.check?.status}
            >
              <MergeSentence text={check} />
            </span>
          )}
        </span>
        <span className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: fix.mine.thread.environmentId, threadId },
              })
            }
          >
            Open chat
          </Button>
          {fix.status === "asking" && allowed ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pending}
              onClick={() => act({ _tag: "undo", threadId }, "Could not undo the fix")}
            >
              Undo
            </Button>
          ) : null}
          {fix.status === "ready" && allowed ? (
            <>
              <Button
                size="xs"
                disabled={pending}
                onClick={() => act({ _tag: "approve", threadId }, "Could not approve the fix")}
              >
                Approve
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending}
                onClick={() => act({ _tag: "undo", threadId }, "Could not undo the fix")}
              >
                Undo
              </Button>
            </>
          ) : null}
        </span>
      </span>
    </li>
  );
}

/**
 * "Fix it" for a clash or files to regenerate; disabled, with why, when it
 * cannot run here. `afterConflict`: an update of this pair stopped on a
 * conflict, so the fix merges in that chat, even though the pair merges cleanly.
 */
function FixItButton(props: {
  readonly environmentId: EnvironmentId;
  readonly pair: TeamMergePair;
  readonly afterConflict?: { readonly threadId: ThreadId; readonly other: TeamMergeOther };
}) {
  const { act, pending, allowed } = useMergeFixAction(props.environmentId);
  const { afterConflict } = props;
  const breaks = props.pair.combined?.status === "broken";
  if ((props.pair.status === "clean" && !breaks && afterConflict === undefined) || !allowed) {
    return null;
  }
  const blocked = afterConflict === undefined ? mergeFixBlocked(props.pair) : null;
  return (
    <>
      {" "}
      <Button
        size="xs"
        variant="outline"
        disabled={pending || blocked !== null}
        title={
          blocked ??
          (breaks && afterConflict === undefined
            ? "A turn in this chat merges the other side and fixes what the combination breaks, without committing. You approve or undo it after."
            : "A turn in this chat merges the other side and resolves the clash, without committing. You approve or undo it after.")
        }
        onClick={() =>
          act(
            {
              _tag: "start",
              projectId: props.pair.projectId,
              threadId: afterConflict?.threadId ?? props.pair.mine.thread.threadId,
              other: afterConflict?.other ?? props.pair.other,
            },
            "Could not start the fix",
          )
        }
      >
        Fix it
      </Button>
    </>
  );
}

/** "Update my copy" / "Update "B" on top of "A"": a merge into the chat's copy, never during a turn or over uncommitted work. */
function UpdateButton(props: {
  readonly environmentId: EnvironmentId;
  readonly pair: TeamMergePair;
  readonly offer: MergeUpdateOffer;
  readonly onConflict: () => void;
}) {
  const { offer } = props;
  const { act, pending, allowed } = useMergeFixAction(props.environmentId, props.onConflict);
  if (!allowed) return null;
  return (
    <>
      {" "}
      <Button
        size="xs"
        variant="outline"
        disabled={pending || offer.blocked !== null}
        title={
          offer.blocked ??
          (offer.anyway
            ? "Merges the other side into the chat's branch without the combined check. Not while its agent works or with uncommitted changes."
            : "Checks the combined result once, then merges the other side into the chat's branch. Not while its agent works or with uncommitted changes.")
        }
        onClick={() =>
          act(
            {
              _tag: "update",
              projectId: props.pair.projectId,
              threadId: offer.threadId,
              other: offer.other,
              ...(offer.anyway ? { anyway: true } : {}),
            },
            "Could not update",
          )
        }
      >
        {offer.label}
      </Button>
    </>
  );
}

/** "Check now": the project's check command on the combined result; it shows on the line. */
function CheckNowButton(props: {
  readonly environmentId: EnvironmentId;
  readonly pair: TeamMergePair;
}) {
  const { act, pending, allowed } = useMergeFixAction(props.environmentId);
  if (!allowed || !combinedCheckOffered(props.pair)) return null;
  return (
    <>
      {" "}
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={pending}
        title="Runs the project's check (typecheck) on the two combined, at low priority, and shows only errors neither side has alone. Installs changed dependencies first."
        onClick={() =>
          act(
            {
              _tag: "check",
              projectId: props.pair.projectId,
              threadId: props.pair.mine.thread.threadId,
              other: props.pair.other,
            },
            "Could not start the check",
          )
        }
      >
        Check now
      </Button>
    </>
  );
}

/** Fixes, then pairs worth a line, then the other clean pairs folded into one that opens on click. */
export function MergePairList(props: {
  readonly environmentId: EnvironmentId;
  readonly team: TeamFeedTeam;
  readonly pairs: ReadonlyArray<TeamMergePair>;
  readonly fixes: ReadonlyArray<TeamMergeFix>;
  readonly pathPrefix: string;
}) {
  const [open, setOpen] = useState(false);
  // Pairs whose update stopped on a conflict, by key and checked commits: "Fix it" merges instead.
  const [conflicted, setConflicted] = useState<ReadonlySet<string>>(() => new Set());
  const { shown, folded } = foldMergePairs(
    props.pairs.filter((pair) => !props.fixes.some((fix) => fixIsForPair(fix, pair))),
  );
  const line = (pair: TeamMergePair) => {
    const offer = mergeUpdateOffer(pair);
    const conflictKey = `${mergePairKey(pair)}|${pair.mine.commit}|${pair.other.commit}`;
    const afterConflict = offer !== null && conflicted.has(conflictKey) ? offer : undefined;
    return (
      <MergePairLine
        key={mergePairKey(pair)}
        team={props.team}
        pair={pair}
        pathPrefix={props.pathPrefix}
        updateStopped={afterConflict !== undefined}
        action={
          <>
            <FixItButton
              environmentId={props.environmentId}
              pair={pair}
              {...(afterConflict === undefined ? {} : { afterConflict })}
            />
            <CheckNowButton environmentId={props.environmentId} pair={pair} />
            {offer !== null && afterConflict === undefined ? (
              <UpdateButton
                environmentId={props.environmentId}
                pair={pair}
                offer={offer}
                onConflict={() => setConflicted((keys) => new Set(keys).add(conflictKey))}
              />
            ) : null}
          </>
        }
      />
    );
  };
  return (
    <ul className="flex flex-col gap-1.5">
      {props.fixes.map((fix) => (
        <MergeFixLine
          key={`fix|${mergePairKey(fix)}`}
          environmentId={props.environmentId}
          team={props.team}
          fix={fix}
          pathPrefix={props.pathPrefix}
        />
      ))}
      {shown.map(line)}
      {folded.length > 0 ? (
        <li className="text-xs">
          <Button size="xs" variant="ghost-muted" onClick={() => setOpen((value) => !value)}>
            {foldedMergeLine(folded.length, shown.length === 0 && props.fixes.length === 0)}
          </Button>
        </li>
      ) : null}
      {open ? folded.map(line) : null}
    </ul>
  );
}

/** The "Merging" section's body on Team home / Today. */
export function TeamMergingList(props: {
  readonly environmentId: EnvironmentId;
  readonly team: TeamFeedTeam;
  readonly projectId: ProjectId;
  readonly pathPrefix: string;
}) {
  const { team } = props;
  if (team.merging?.unavailable !== undefined) {
    return <p className="text-xs text-muted-foreground">{team.merging.unavailable}</p>;
  }
  // Clashes first, as the server orders them.
  const pairs = projectMergePairs(team, props.projectId);
  const fixes = projectMergeFixes(team, props.projectId);
  if (pairs.length === 0 && fixes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {team.solo
          ? "Nothing to report. After each turn, chats with their own worktree are combined with each other and with the main branch to find clashes before you merge."
          : "Nothing to report. After each turn, your chats are combined with teammates' pushed branches and the main branch to find clashes before you merge."}
      </p>
    );
  }
  return (
    <MergePairList
      environmentId={props.environmentId}
      team={team}
      pairs={pairs}
      fixes={fixes}
      pathPrefix={props.pathPrefix}
    />
  );
}
