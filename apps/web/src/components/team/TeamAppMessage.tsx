/**
 * team-layer: a message T3 sent to the agent on the user's behalf, to carry a
 * warning card's outcome ("Done waiting: …", a choice made after the turn
 * ended, a teammate's answer). It is stored as a user message, so the agent
 * reads it as one, but the user did not type it: it is drawn as the app's.
 */
import type { OrchestrationMessage } from "@t3tools/contracts";
import { CornerDownRightIcon } from "lucide-react";
import { memo } from "react";

/** Text with `code` spans, the only markup these messages use. Keyed by offset in the text. */
function InlineCode(props: { readonly text: string }) {
  let offset = 0;
  return props.text.split("`").map((part, index) => {
    const at = offset;
    offset += part.length + 1;
    return index % 2 === 1 ? (
      <code key={at} className="rounded bg-muted px-1 font-mono text-foreground/90">
        {part}
      </code>
    ) : (
      <span key={at}>{part}</span>
    );
  });
}

export const TeamAppMessage = memo(function TeamAppMessage(props: {
  readonly message: OrchestrationMessage;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 px-1 py-0.5 text-xs" data-team-app-message>
      <CornerDownRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <span className="font-medium text-muted-foreground">Sent by T3 Code</span>
        <p className="mt-0.5 whitespace-pre-wrap text-foreground/80">
          <InlineCode text={props.message.text} />
        </p>
      </div>
    </div>
  );
});
