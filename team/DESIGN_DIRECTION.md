# Design direction for the team layer (VISION.md step 3)

Status: proposal, 2026-10-07. Waiting for a pick. Mockups are in [mockups/](mockups/) (open `mockups/index.html`); screenshots are on the `test-screenshots` branch, folder `2026-10-07-design/`.

Step 3 has to make three things visible: the team screen, the file markers, and the warning card from VISION.md 3.1. Each has to work with a team and solo (VISION.md 6.3), in light and dark, without slowing the app down.

## 1. What we take from the reference

The reference is the two screenshots in [mockups/reference/](mockups/reference/).

- **Layout.** A narrow icon rail, a thread sidebar (title on one line, branch and PR under it), chats as tabs on top, one centered chat column, and a right panel with tabs (Terminal, Explorer, Browser). T3 already has most of this; we keep it.
- **Quiet chrome.** Small type (13 px), grey text for anything secondary, hairline borders instead of boxes, one accent color. Status is a small dot, not a badge.
- **Cards for structured results.** The "Edited 4 files" card with +/- counts is where we show the agent's plan ("3 files planned, checked against claims"), with a holder chip on each file.
- **Pills in the composer.** Small pills for state ("Full access"); we add one for team state ("2 files held by Yassine").

## 2. What we do differently

- **The glass shows.** In the reference the sidebar is barely tinted. Ours lets the desktop picture through, softly: the sidebar and rail most, the right panel less, the chat column least (it is for reading). See section 3.
- **People and chats have a color.** Each teammate gets one hue for their initials chip; in solo, each chat gets one. The same chip marks a held file in the plan card, the file tree, the sidebar and the tabs. A chip is the only new visual idea; it is reused everywhere.
- **Team state in plain words.** "Yassine holds", "Search page is editing", "not merged yet", "synced 8 s ago". No icons without words for anything that matters.
- **No motion that repeats.** Cards appear with one 140 ms fade; nothing pulses or spins while idle (AGENTS.md: no continuously repainting animations).

## 3. How the glass works

The mockups fake it with a wallpaper and a CSS `backdrop-filter` on the window. **The app must not do that**: a full-window CSS blur repaints on every scroll and costs GPU on high-refresh screens. In the app the OS draws the material behind a transparent window, and the page only uses translucent background colors. The renderer blurs nothing.

| Platform                                                | How                                                                                                                                                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows 11** (22H2, build 22621 or later)             | Electron `backgroundMaterial: "mica"` on the main window (or `win.setBackgroundMaterial`). Mica samples the desktop picture, not the windows behind, so it is cheap and calm. `"acrylic"` (a real blur of what is behind) only if we ever want it for a popover window; not for the main window. | The window background must be transparent for the material to show (today `DesktopWindow.ts` sets an opaque `backgroundColor`). Mica turns solid when the window is not focused; that is the OS design, keep it. T3 uses `titleBarStyle: "hidden"` with `titleBarOverlay` on Windows; whether the material fills the title bar area with that setup must be checked on a real Windows 11 machine (see WINDOWS_AND_SOLO.md). |
| **macOS**                                               | Electron `vibrancy: "sidebar"` with `visualEffectState: "followWindow"`. The page keeps the sidebar and rail transparent, the chat column almost opaque.                                                                                                                                         | Same rule: transparent window background. Vibrancy follows light/dark by itself.                                                                                                                                                                                                                                                                                                                                            |
| **Windows 10, Windows 11 before 22H2, Linux**           | No material. The tokens fall back to today's solid colors.                                                                                                                                                                                                                                       | Detect on the desktop side (OS build), never in CSS.                                                                                                                                                                                                                                                                                                                                                                        |
| **"Transparency effects" off, or reduced transparency** | Solid colors, as above.                                                                                                                                                                                                                                                                          | Electron's `nativeTheme.prefersReducedTransparency` (check it in Electron 44's docs before relying on it); the OS also turns Mica off by itself.                                                                                                                                                                                                                                                                            |
| **Web** (app.t3.codes, `npx t3`) and **mobile**         | Solid colors.                                                                                                                                                                                                                                                                                    | A browser cannot see the desktop. Mobile can add native blur later on its own; out of scope.                                                                                                                                                                                                                                                                                                                                |

How the page switches: the desktop shell sets one attribute on `<html>` (for example `data-window-material="os"`) when the OS draws a material. `apps/web/src/index.css` defines translucent versions of the background tokens under that attribute only. One small `team-layer:` edit in each of the two upstream files; nothing changes for web, mobile, or desktop without a material.

Readability rule: the chat column stays at least about 80% opaque and the right panel about 65% (what the mockups use: `--surface` and `--panel` over `--chrome`). Text never sits on the raw material.

## 4. The three options

Each option has a team and a solo version, and a warning card. Screenshots: `<option>-<light|dark>-<team|solo>[-card].png`.

**A · Team tab** ([option-a.html](mockups/option-a.html))

- Idea: the team is one more tab in the right panel, next to Terminal, Files and Browser (solo: "Memory"). The warning card sits above the composer, where T3 already asks for approvals (`ComposerPendingApprovalPanel`).
- Good at: smallest change to T3; no new navigation; the card is where users already answer the agent.
- Weak: hidden whenever the panel is closed or on another tab, which breaks "nothing important hidden" (VISION.md 6.2); the panel is narrow; mobile has no right panel.

**B · Presence bar** ([option-b.html](mockups/option-b.html))

- Idea: no panel. Teammates' faces and "synced 8 s ago" sit in the tab bar, always visible; a click opens a glass popover with who is on what and the latest handoffs. The warning card is a sheet over the chat.
- Good at: always visible at almost no cost in space; works in narrow windows and maps to a mobile header; sync state is never hidden.
- Weak: every detail is behind a click; the sheet covers the plan it is asking about; the popover covers the chat; no room for "Catch me up" or "Plan together".

**C · Team home** ([option-c.html](mockups/option-c.html))

- Idea: the team gets its own page from the rail (solo: "Today") with catch-up, people, tasks and notes. In a chat, the sidebar keeps a small who-is-around block, and the warning card shows inside the agent's message, where it stopped.
- Good at: room for the features that make people come back (Catch me up, Plan together, the solo "Today"); the card stays in the thread as a record of what was chosen; a page and an inline card both carry over to mobile.
- Weak: the most new UI (a route and a page); the page is away from the chat, so people must go there; the sidebar block costs vertical space.

## 5. What I would pick

**C, with B's presence chip added to the tab bar.**

- VISION.md asks for "a team screen and a clear warning card" and for catch-up and planning together. Only C has a place for those; A and B would need a page later anyway.
- The inline card is the right home for VISION.md 3.1 and 3.2: the agent stops in its message, the user picks, and the choice stays in the thread history, for the user, for a later "catch me up", and on mobile, where a sheet or a right panel does not fit.
- Solo gets a real page ("Today": catch-up, your running chats and their overlaps, notes) instead of an empty team tab, which is VISION.md 6.3.
- B's chip ("YA SA · synced 8 s") costs one element in the tab bar and fixes C's weakness: you see who is around and whether the state is fresh without leaving the chat. It is also where "not fresh" (the failed-read case fixed today) can show.
- The file markers (chips in the plan card, the file tree, the sidebar, the tabs) are the same in all three options, so they can be built first whatever the pick.

Build order if C is picked: markers and the plan card; the inline warning card; the presence chip; the Team home / Today page; then the glass (section 3), last, since it is independent and needs the Windows 11 check.
