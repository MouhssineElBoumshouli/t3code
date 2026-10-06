# T3 Code + team layer (paused prototype)

This is my fork of [T3 Code](https://github.com/pingdotgg/t3code). I tried to add a "team layer" so several people can each use their own AI coding agent (Claude Code, Codex) on the same project without getting in each other's way.

**What works:**
- A shared team memory on one computer. Every agent knows the project rules, who is working on what, and its own task.
- File claims. Before an agent edits a file, it reserves it. If another agent wants the same file, it warns the user first.
- Handoff notes and memory search. Each note is marked fresh or "maybe outdated" based on whether the files changed since it was written.
- A "cold start" test. A brand new chat, with no hints, answered 5 questions about the project correctly. It passed with both Claude and Codex.
- The first steps for teammates on other computers: limited team-only access, invite links, and security tests that try every door in the app with a teammate's key.

**Status:** paused. The design and progress notes are in the [`team/`](team/) folder.

While building this, I found a security bug in T3 Code and reported it privately to their team.

All credit for T3 Code goes to T3 Tools Inc. It is MIT licensed.

---
