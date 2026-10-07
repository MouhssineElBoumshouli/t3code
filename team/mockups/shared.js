// Shared pieces for the team-layer mockups. Static and clickable, no app code.
// URL query: theme=light|dark, mode=team|solo, card=1 (warning card open),
// pane=<right panel tab>, view=chat|home (Option C), shot=1 (hide the mockup
// controls for screenshots).

const Mock = (() => {
  const params = new URLSearchParams(location.search);
  const state = {
    theme: params.get("theme") === "dark" ? "dark" : "light",
    mode: params.get("mode") === "solo" ? "solo" : "team",
    card: params.get("card") === "1",
    pane: params.get("pane"),
    view: params.get("view") === "home" ? "home" : "chat",
    picked: null,
    shot: params.get("shot") === "1",
  };

  const icon = (name, cls = "") => {
    const paths = {
      home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
      chats: '<path d="M4 5h16v10H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
      team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.4.2 4 1.8 4.5 4.5"/>',
      memory: '<path d="M12 4a8 8 0 1 0 8 8"/><path d="M12 8v4l3 2"/><path d="M17 3v4h4"/>',
      settings:
        '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
      files:
        '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
      globe:
        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/>',
      warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
      check: '<path d="m5 12 4 4 10-10"/>',
      sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
      cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.4 1.6A3.3 3.3 0 0 0 7 18z"/>',
      chevron: '<path d="m9 6 6 6-6 6"/>',
      down: '<path d="m6 9 6 6 6-6"/>',
      x: '<path d="M6 6l12 12M18 6 6 18"/>',
      branch:
        '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10 6"/>',
      send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
      wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
      ask: '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 9.5a2 2 0 1 1 2.5 1.9c-.4.2-.5.5-.5.9V13M12 15.5v.1"/>',
      route:
        '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/>',
      go: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
      panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
      sparkle:
        '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
      lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    };
    return `<svg class="i ${cls}" viewBox="0 0 24 24">${paths[name] ?? ""}</svg>`;
  };

  // ---------- Data ----------

  const people = {
    me: { name: "Mouhssine", initials: "MO", color: "var(--you)" },
    yassine: { name: "Yassine", initials: "YA", color: "var(--yassine)" },
    sara: { name: "Sara", initials: "SA", color: "var(--sara)" },
  };

  const chats = {
    search: { title: "Search page", color: "var(--chat-1)" },
    paging: { title: "Fix paging", color: "var(--chat-2)" },
  };

  const who = (p, cls = "") =>
    `<span class="who ${cls}" style="--c:${p.color}">${p.initials}</span>`;
  const held = (p, label = `${p.name} holds`) =>
    `<span class="held" style="--c:${p.color}">${who(p)}${label}</span>`;
  // Where there is no room for a name: the holder's initials only.
  const heldMini = (p) =>
    `<span class="who" style="--c:${p.color}" title="${p.name} holds files this touches">${p.initials}</span>`;
  const heldChat = (c, label = c.title) =>
    `<span class="held by-chat" style="--c:${c.color}">${label}</span>`;

  // ---------- Pieces ----------

  const rail = (items) => `
    <nav class="rail">
      <div class="lights"><i></i><i></i><i></i></div>
      ${items
        .map(
          (item) =>
            `<button class="rail-btn ${item.on ? "on" : ""} ${item.only ?? ""}" title="${item.title}" ${
              item.go ? `data-go="${item.go}"` : ""
            }>${icon(item.icon)}${item.dot ? '<span class="dot"></span>' : ""}</button>`,
        )
        .join("")}
      <div class="rail-spacer"></div>
      <button class="rail-btn" title="Settings">${icon("settings")}</button>
    </nav>`;

  const threadRow = (t) => `
    <a class="thread ${t.on ? "on" : ""}">
      <div class="thread-title"><span class="status ${t.status}"></span><span class="t">${t.title}</span>${t.marker ?? ""}</div>
      <div class="thread-meta">${t.meta}</div>
    </a>`;

  const sidebar = (extraTop = "") => `
    <aside class="sidebar">
      <div class="sidebar-head"><span>team-demo</span>${icon("down", "sm")}<span class="grow"></span>
        <button class="icon-btn" title="Search">${icon("search", "sm")}</button></div>
      <a class="side-action">${icon("plus", "sm")} New chat</a>
      ${extraTop}
      <div class="team-only">
        <div class="side-group">Open</div>
        ${threadRow({
          title: "Remember me on login",
          status: "waiting",
          on: true,
          marker: heldMini(people.yassine),
          meta: `${icon("branch", "sm")} mouhssine/remember-me`,
        })}
        ${threadRow({ title: "Search page", status: "working", meta: `${icon("branch", "sm")} mouhssine/search` })}
        ${threadRow({ title: "Fix paging", status: "", meta: `${icon("branch", "sm")} mouhssine/paging` })}
        <div class="side-group">Earlier</div>
        ${threadRow({
          title: "Avatar crop bug",
          status: "done",
          marker: heldMini(people.sara),
          meta: `${icon("branch", "sm")} mouhssine/avatar-crop`,
        })}
        ${threadRow({ title: "Project setup", status: "done", meta: "main" })}
      </div>
      <div class="solo-only">
        <div class="side-group">Open</div>
        ${threadRow({
          title: "Fix paging",
          status: "waiting",
          on: true,
          marker: heldChat(chats.search, "overlap"),
          meta: `${icon("branch", "sm")} paging`,
        })}
        ${threadRow({
          title: "Search page",
          status: "working",
          marker: `<span class="mark" style="--c:${chats.search.color}"></span>`,
          meta: `${icon("branch", "sm")} search`,
        })}
        ${threadRow({ title: "Dark mode toggle", status: "", meta: `${icon("branch", "sm")} dark-mode` })}
        <div class="side-group">Earlier</div>
        ${threadRow({ title: "Project setup", status: "done", meta: "main" })}
      </div>
    </aside>`;

  const tabStrip = (right = "") => `
    <header class="tabs">
      <span class="team-only" style="display:contents">
        <a class="tab on"><span class="status waiting"></span><span class="t">Remember me on login</span>${heldMini(people.yassine)}</a>
        <a class="tab"><span class="status working"></span><span class="t">Search page</span></a>
        <a class="tab"><span class="status"></span><span class="t">Fix paging</span></a>
      </span>
      <span class="solo-only" style="display:contents">
        <a class="tab on"><span class="status waiting"></span><span class="t">Fix paging</span>${heldChat(chats.search, "overlap")}</a>
        <a class="tab"><span class="status working"></span><span class="t">Search page</span><span class="mark" style="--c:${chats.search.color}"></span></a>
        <a class="tab"><span class="status"></span><span class="t">Dark mode toggle</span></a>
      </span>
      <button class="icon-btn" title="New chat">${icon("plus", "sm")}</button>
      <span class="grow"></span>
      ${right}
    </header>`;

  // The plan the agent made before writing code (VISION.md 3.1).
  const planTeam = `
    <div class="msg-user"><div>Add a "remember me" checkbox to the login form. Keep the session for 30 days when it is ticked.</div></div>
    <div class="worked">Planned for 12s ${icon("chevron", "sm")}</div>
    <div class="msg-agent">
      <p>Before writing code, here is what I expect to touch:</p>
      <div class="files-card">
        <div class="row">${icon("file", "sm")}<span class="grow">3 files planned</span><span class="faint">checked against claims</span></div>
        <div class="row">${icon("file", "sm")}<span class="grow mono">src/auth/login.ts</span>${held(people.yassine)}</div>
        <div class="row">${icon("file", "sm")}<span class="grow mono">src/auth/LoginForm.tsx</span>${held(people.yassine)}</div>
        <div class="row">${icon("file", "sm")}<span class="grow mono">src/api/session.ts</span><span class="faint">free</span></div>
      </div>
    </div>`;

  const planSolo = `
    <div class="msg-user"><div>Page size should be 50, and keep the cursor when the filters change.</div></div>
    <div class="worked">Planned for 9s ${icon("chevron", "sm")}</div>
    <div class="msg-agent">
      <p>Before writing code, here is what I expect to touch:</p>
      <div class="files-card">
        <div class="row">${icon("file", "sm")}<span class="grow">2 files planned</span><span class="faint">checked against your other chats</span></div>
        <div class="row">${icon("file", "sm")}<span class="grow mono">src/search/query.ts</span>${heldChat(chats.search, "Search page is editing")}</div>
        <div class="row">${icon("file", "sm")}<span class="grow mono">src/search/Paging.tsx</span><span class="faint">free</span></div>
      </div>
    </div>`;

  const composer = (extraPills = "") => `
    <div class="composer">
      <div class="ph">Ask anything, @tag files, or use / for commands</div>
      <div class="bar">${icon("plus", "sm")}<span class="pill">Full access</span>${extraPills}<span class="grow"></span>
        <span>Claude Opus 5.5</span><span class="faint">High</span><span class="send">${icon("send", "sm")}</span></div>
    </div>`;

  // ---------- Warning card ----------

  const cardChoices = {
    team: [
      [
        "wait",
        "Wait for Yassine",
        "Start by itself when his login work is merged, on top of his version.",
        "Recommended",
      ],
      ["layers", "Build on top of his work", "Start from his unmerged branch yassine/login.", ""],
      [
        "ask",
        "Ask Yassine",
        "Send “Can I touch login.ts?” He answers from the app or his phone.",
        "",
      ],
      ["route", "Find another way", "The agent tries the task without his files.", ""],
      ["go", "Go anyway", "Both of you are warned; help with merging later.", ""],
    ],
    solo: [
      [
        "wait",
        "Wait for “Search page”",
        "Start by itself when that chat finishes and its work is merged.",
        "Recommended",
      ],
      ["layers", "Build on top of it", "Start from that chat's branch, search.", ""],
      ["ask", "Open “Search page”", "Jump to that chat to finish or stop it first.", ""],
      ["route", "Find another way", "The agent tries the task without query.ts.", ""],
      ["go", "Go anyway", "Both chats edit it; help with merging later.", ""],
    ],
  };

  const warningCard = (mode, extraClass = "") => {
    const team = mode === "team";
    const head = team
      ? `<div class="title">Yassine is working on login right now.</div>
         <div class="sub">Your task will probably change <span class="mono">login.ts</span> and <span class="mono">LoginForm.tsx</span> too. He claimed <span class="mono">src/auth/</span> 40 min ago.</div>`
      : `<div class="title">Your other chat “Search page” is editing query.ts.</div>
         <div class="sub">This task will probably change <span class="mono">src/search/query.ts</span> too. That chat has not finished yet.</div>`;
    const avatar = team
      ? who(people.yassine, "lg")
      : `<span class="who lg" style="--c:var(--chat-1)">${icon("chats", "sm")}</span>`;
    return `
      <div class="warn-card appear ${extraClass}" data-card>
        <div class="top">${avatar}<div class="txt">${head}</div></div>
        <div class="choices">
          ${cardChoices[mode]
            .map(
              ([ic, label, desc, tag], index) => `
            <button class="choice ${index === 0 ? "first" : ""} ${state.picked === index ? "picked" : ""}" data-pick="${index}">
              <span class="k">${index + 1}</span>
              <span><div class="l">${label}</div><div class="d">${desc}</div></span>
              <span class="tag">${state.picked === index ? `${icon("check", "sm")}` : tag}</span>
            </button>`,
            )
            .join("")}
        </div>
        <div class="warn-foot">${icon("lock", "sm")}<span class="grow">The agent waits for your choice. Nothing is edited yet.</span><span>Press 1–5</span></div>
      </div>`;
  };

  // ---------- Right panel bodies ----------

  const terminal = () => `
    <div class="terminal"><span class="p">~/code/team-demo</span> <span class="faint">(mouhssine/remember-me)</span>
$ vp test run src/auth
<span class="g"> ✓</span> src/auth/login.test.ts (6 tests) 42ms
<span class="g"> ✓</span> src/auth/session.test.ts (4 tests) 18ms

 Test Files  2 passed (2)
      Tests  10 passed (10)

<span class="p">~/code/team-demo</span> <span class="faint">(mouhssine/remember-me)</span>
$ <span style="opacity:.6">▍</span></div>`;

  const fileTree = () => `
    <div class="tree">
      <div class="node dir">${icon("down", "sm")}${icon("files", "sm")}<span class="grow">src</span></div>
      <div class="team-only">
        <div class="node dir" style="padding-left:24px">${icon("down", "sm")}${icon("files", "sm")}<span class="grow">auth</span>${heldMini(people.yassine)}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">login.ts</span>${heldMini(people.yassine)}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">LoginForm.tsx</span>${heldMini(people.yassine)}</div>
        <div class="node dir" style="padding-left:24px">${icon("chevron", "sm")}${icon("files", "sm")}<span class="grow">api</span></div>
        <div class="node dir" style="padding-left:24px">${icon("down", "sm")}${icon("files", "sm")}<span class="grow">profile</span></div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">avatar.ts</span>${heldMini(people.sara)}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">Profile.tsx</span></div>
        <div class="node dir" style="padding-left:24px">${icon("down", "sm")}${icon("files", "sm")}<span class="grow">search</span></div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">query.ts</span>${held(people.me, "you")}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">Paging.tsx</span></div>
      </div>
      <div class="solo-only">
        <div class="node dir" style="padding-left:24px">${icon("chevron", "sm")}${icon("files", "sm")}<span class="grow">auth</span></div>
        <div class="node dir" style="padding-left:24px">${icon("down", "sm")}${icon("files", "sm")}<span class="grow">search</span>${heldChat(chats.search)}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">query.ts</span>${heldChat(chats.search)}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">Paging.tsx</span>${heldChat(chats.paging, "this chat")}</div>
        <div class="node" style="padding-left:58px">${icon("file", "sm")}<span class="grow mono">Results.tsx</span></div>
        <div class="node dir" style="padding-left:24px">${icon("chevron", "sm")}${icon("files", "sm")}<span class="grow">ui</span></div>
      </div>
      <div class="node">${icon("file", "sm")}<span class="grow mono">package.json</span></div>
      <div class="node">${icon("file", "sm")}<span class="grow mono">README.md</span></div>
    </div>`;

  // ---------- Team and solo sections, used by every option ----------

  const peopleNow = () => `
    <div class="person">${who(people.yassine, "lg")}<div>
      <div class="name">Yassine <span class="pill ok"><span class="d"></span>active 2 min ago</span></div>
      <div class="what">Login page · own branch, not merged yet</div>
      <div class="paths"><span class="path">src/auth/</span><span class="path">src/api/session.ts</span></div></div></div>
    <div class="person">${who(people.sara, "lg")}<div>
      <div class="name">Sara <span class="pill">last active 3 h ago</span></div>
      <div class="what">Avatar upload</div>
      <div class="paths"><span class="path">src/profile/avatar.ts</span></div></div></div>
    <div class="person">${who(people.me, "lg")}<div>
      <div class="name">You</div>
      <div class="what">Search page · Remember me on login</div>
      <div class="paths"><span class="path">src/search/</span></div></div></div>`;

  const tasksList = () => `
    <div class="task"><span class="check doing"></span><span class="grow">Login page</span>${who(people.yassine)}</div>
    <div class="task"><span class="check doing"></span><span class="grow">Search page</span>${who(people.me)}</div>
    <div class="task"><span class="check doing"></span><span class="grow">Avatar upload</span>${who(people.sara)}</div>
    <div class="task"><span class="check"></span><span class="grow">Password reset</span><span class="faint">nobody yet</span></div>
    <div class="task"><span class="check done"></span><span class="grow muted">Project setup</span>${who(people.me)}</div>`;

  const handoffsTeam = () => `
    <div class="note"><div class="head">${who(people.sara)}Sara · 14:02 · <span class="pill ok"><span class="d"></span>fresh</span></div>
      <div class="body">Avatar upload works for PNG and JPG. Resizing is left.</div></div>
    <div class="note"><div class="head">${who(people.yassine)}Yassine · 11:40 · <span class="pill warn"><span class="d"></span>not merged yet</span></div>
      <div class="body">Login form posts to /api/session. Error states are left.</div></div>
    <div class="note"><div class="head">${who(people.me)}You · yesterday 18:12</div>
      <div class="body">Query parser done. Paging is left.</div></div>`;

  const syncRow = (extra = "") => `
    <div class="sync">${icon("cloud", "sm")}<span class="grow">Synced with GitHub 8 s ago</span>${extra}<span class="pill ok"><span class="d"></span>online</span></div>`;

  const catchUp = () => `
    <div class="callout">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><b>Since yesterday 18:12</b></div>
      2 chats ran and changed 9 files in <span class="mono">src/search/</span> and <span class="mono">src/ui/</span>.
      One handoff note. Nothing you noted is outdated.
    </div>`;

  const myChatsNow = () => `
    <div class="task"><span class="status working"></span><span class="grow">Search page</span>${heldChat(chats.search, "src/search/")}</div>
    <div class="task"><span class="status waiting"></span><span class="grow">Fix paging</span>${heldChat(chats.paging, "Paging.tsx")}</div>
    <div class="task"><span class="status"></span><span class="grow">Dark mode toggle</span><span class="faint">nothing held</span></div>
    <div class="callout warn" style="margin-top:8px">${icon("warn", "sm")} <b>Fix paging</b> and <b>Search page</b> both plan to change <span class="mono">query.ts</span>.</div>`;

  const notesSolo = () => `
    <div class="note"><div class="head"><span class="mark" style="--c:${chats.search.color}"></span>Search page · yesterday 18:12 · <span class="pill ok"><span class="d"></span>fresh</span></div>
      <div class="body">Query parser done. Paging is left.</div></div>
    <div class="note"><div class="head"><span class="mark" style="--c:var(--faint)"></span>Project setup · Monday · <span class="pill warn"><span class="d"></span>maybe outdated</span></div>
      <div class="body">Routes live in src/app/routes.ts; tests run with vp test.</div></div>`;

  const memorySearch = () => `
    <div class="search">${icon("search", "sm")}Search notes and decisions…</div>`;

  // ---------- Wiring ----------

  const controls = (option, extra) => {
    const link = (patch, label, on) => {
      const next = new URLSearchParams(location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return `<a href="?${next}" class="${on ? "on" : ""}">${label}</a>`;
    };
    return `
      <div class="controls">
        <a href="index.html">All options</a>
        <span style="opacity:.5;padding:5px 4px">Option ${option}</span>
        ${link({ theme: "light" }, "Light", state.theme === "light")}
        ${link({ theme: "dark" }, "Dark", state.theme === "dark")}
        ${link({ mode: "team" }, "Team", state.mode === "team")}
        ${link({ mode: "solo" }, "Solo", state.mode === "solo")}
        ${link({ card: state.card ? null : "1" }, state.card ? "Hide warning card" : "Show warning card", state.card)}
        ${extra ? extra(link) : ""}
      </div>`;
  };

  /** `extra(link)` adds option-specific links to the controls. */
  const mount = (option, render, extra) => {
    const root = document.documentElement;
    const paint = () => {
      root.dataset.theme = state.theme;
      root.dataset.mode = state.mode;
      root.dataset.shot = state.shot ? "1" : "0";
      document.body.innerHTML = render(state) + controls(option, extra);
    };
    document.addEventListener("click", (event) => {
      const pick = event.target.closest("[data-pick]");
      if (pick) {
        state.picked = Number(pick.dataset.pick);
        paint();
        return;
      }
      const pane = event.target.closest("[data-pane]");
      if (pane) {
        state.pane = pane.dataset.pane;
        paint();
        return;
      }
      const go = event.target.closest("[data-go]");
      if (go) {
        state.view = go.dataset.go;
        paint();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (!state.card) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < 5) {
        state.picked = index;
        paint();
      }
    });
    paint();
  };

  return {
    state,
    icon,
    people,
    chats,
    who,
    held,
    heldMini,
    heldChat,
    rail,
    sidebar,
    tabStrip,
    planTeam,
    planSolo,
    composer,
    warningCard,
    terminal,
    fileTree,
    peopleNow,
    tasksList,
    handoffsTeam,
    syncRow,
    catchUp,
    myChatsNow,
    notesSolo,
    memorySearch,
    mount,
  };
})();
