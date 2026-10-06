# 2026-10-07 part 0: first self-test (pairing)

- `main` commit: 0d6f3c408
- Dev server: `vp run dev --home-dir ~/.t3-dev` (fresh, empty home), web port 5733, server port 13773.
- Browser: Playwright MCP, headless Chromium, fresh profile.

What was done: opened the dev server's one-time pairing URL in the Playwright browser. The page moved from `/pair` to `/`, showed the splash, then `/welcome`.

- `01-splash-after-pairing.png`: right after pairing, the T3 splash while the app loads (about 5 s after the visit).
- `02-welcome-after-pairing.png`: about 20 s later, the "Set up T3 Code" dialog, step 1 "Connect your computers", with this computer (`MouhssineVic`, `http://localhost:5733/`) checked and marked "Connected". Behind it, the sidebar says "No projects yet". No pairing link or token is on the page.
