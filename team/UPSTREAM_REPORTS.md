# Bugs to report to upstream T3 Code

Bugs we found in upstream code while working on the fork. Each entry is written so it can be pasted into an upstream issue. Our fix, if we made one, is marked `team-layer:` in the code.

## The first chat after "Add project → Local folder" ignores `t3.json`

Found 2026-10-07 in the slice 8 self-test. Fixed in our fork (see below); not reported yet.

**What happens.** A project whose `t3.json` sets `defaultThreadEnvMode` to `worktree` is added with the command palette's "Add project → Local folder". The first draft opens in the current checkout ("Current checkout") instead of a new worktree. Every later new thread in the same project follows `t3.json` and says "New worktree".

**Why.** `useHandleNewThread` resolves the env mode with `resolveDefaultEnvMode`: project override, then the environment setting, then `t3.json`, then the built-in `local` (`packages/shared/src/projectSettings.ts`). It reads `t3.json` only when the project is known on the client (`readProjects()` at call time). The local folder branch in `CommandPalette.tsx` calls `handleNewThread` right after `createProject` returns, before the project's create event reaches the client store, so `t3.json` is skipped and the draft gets `local`. The clone flow in the same file already waits for the project (`waitForProject(projectRef, 3_000)`, with a comment saying why).

**How to reproduce.** Put `"defaultThreadEnvMode": "worktree"` in a Git repo's `t3.json`, leave the environment and project settings unset, add the folder with "Add project → Local folder". The draft shows "Current checkout". Open a second new thread in the same project: it shows "New worktree".

**Fix.** In the local folder branch, before `handleNewThread`:

```ts
await waitForProject(scopeProjectRef(input.environmentId, projectId), 3_000).catch(() => null);
```

The same timeout and fallback as the clone flow: if the event is slow, the draft opens as it does today.

**Also checked.** The setup wizard's project import (`WelcomeWizard.tsx`) creates projects but does not open a draft right after, so it does not have this race.

**Test.** None added: the flow lives inside the palette's callback, and a test would need to render the whole palette or move the flow out of the component, which is a bigger change than the fix. The desktop activation flow has the same wait and tests its order (`desktopAppActivation.test.ts`).
