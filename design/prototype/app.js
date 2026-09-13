const paths = {
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chat: "M4 4h16v12H9l-5 4z",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  folder: "M3 6h6l2 2h10v12H3z",
  chevron: "m9 6 6 6-6 6",
  down: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  branch:
    "M6 8v8m0-5h7a5 5 0 0 0 5-5M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  panel: "M3 4h18v16H3zM9 4v16",
  settings:
    "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
  file: "M5 2h9l5 5v15H5zM14 2v6h5",
  terminal: "m4 6 5 5-5 5m8 1h8",
  globe:
    "M2 12h20M12 2c7 6 7 14 0 20-7-6-7-14 0-20M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  close: "m6 6 12 12M6 18 18 6",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  copy: "M8 8h12v13H8zM4 16H2V2h12v2",
  undo: "M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12",
  mic: "M9 3h6v11H9zM5 11v2a7 7 0 0 0 14 0v-2M12 20v3",
  spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  pin: "m8 3 8 0-1 7 4 4H5l4-4-1-7M12 14v8",
  archive: "M3 3h18v5H3zM5 8v13h14V8M9 12h6",
  link: "m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
};
const i = (n) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[n] ? `<path d="${paths[n]}"/>` : '<circle cx="12" cy="12" r="8"/>'}</svg>`;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const btn = (icon, label, action, cls = "") =>
  `<button class="${cls}" data-action="${action}" title="${label}" aria-label="${label}">${i(icon)}<span>${label}</span></button>`;
const ib = (icon, label, action) =>
  `<button class="icon" data-action="${action}" title="${label}" aria-label="${label}">${i(icon)}</button>`;
let saved;
try {
  saved = JSON.parse(localStorage.getItem("muse-prototype") || "null");
} catch {}
let state = {
  page: "task",
  panel: "diff",
  file: 0,
  project: "muse-web",
  task: 0,
  theme: saved?.theme || "light",
  collapsed: false,
  committed: false,
  approved: false,
  running: false,
  model: "Muse Spark 1.3",
  mode: "Agent",
  environment: "Worktree",
  tasks: saved?.tasks || [
    {
      title: "Créer une page d’accueil",
      prompt:
        "Crée une page d’accueil pour notre studio créatif. Une direction minimaliste, une navigation responsive et une section projets. Appuie-toi sur les composants existants.",
      project: "muse-web",
    },
    {
      title: "Améliorer l’accessibilité",
      prompt: "Améliore l’accessibilité du formulaire de contact.",
      project: "muse-web",
    },
    {
      title: "Ajouter le mode sombre",
      prompt: "Ajoute un thème sombre à l’application.",
      project: "design-system",
    },
  ],
  automations: saved?.automations || [
    {
      name: "Revue quotidienne du code",
      prompt:
        "Analyser les dernières modifications et signaler les régressions.",
      schedule: "Tous les jours · 09:00",
      on: true,
    },
    {
      name: "Résumé des pull requests",
      prompt: "Résumer les pull requests ouvertes et les points à revoir.",
      schedule: "Lundi · 08:30",
      on: false,
    },
  ],
  plugins: saved?.plugins || ["GitHub", "Figma"],
  messages: {},
  attachment: "",
  draft: "",
};
const save = () =>
  localStorage.setItem(
    "muse-prototype",
    JSON.stringify({
      theme: state.theme,
      tasks: state.tasks,
      automations: state.automations,
      plugins: state.plugins,
    }),
  );
function toast(t) {
  const el = document.querySelector("#toast");
  el.textContent = t;
  el.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function shell() {
  document.body.classList.toggle("dark", state.theme === "dark");
  document.querySelector("#app").innerHTML =
    `<div class="app ${state.collapsed ? "collapsed" : ""}"><aside class="sidebar"><div class="brand"><span class="muse-logo"><img src="../assets/muse-logo.png" alt="" aria-hidden="true"></span><div class="brand-text">Muse-Desktop</div>${ib("panel", "Réduire la navigation", "collapse")}</div><div class="sidebar-scroll"><nav class="nav">${btn("plus", "Nouvelle tâche", "new", state.page === "new" ? "active" : "")}${btn("search", "Rechercher", "search")}${btn("clock", "Automatisations", "automations", state.page === "automations" ? "active" : "")}${btn("grid", "Extensions", "plugins", state.page === "plugins" ? "active" : "")}</nav><div class="section-label">Projets ${ib("plus", "Ajouter un projet", "project")}</div>${[
      "muse-web",
      "design-system",
    ]
      .concat(
        state.tasks
          .map((t) => t.project)
          .filter((p) => !["muse-web", "design-system"].includes(p)),
      )
      .filter((p, k, a) => a.indexOf(p) === k)
      .map(
        (p) =>
          `<button class="project" data-project="${esc(p)}">${i("folder")}${esc(p)} ${i("down")}</button><div class="tasks">${state.tasks.map((t, k) => (t.project === p ? `<button class="task ${state.page === "task" && state.task === k ? "active" : ""}" data-task="${k}"><span class="dot ${k === 0 ? "blue" : ""}"></span><span>${esc(t.title)}</span></button>` : "")).join("")}</div>`,
      )
      .join(
        "",
      )}<div class="section-label">Espace personnel</div><nav class="nav">${btn("archive", "Tâches archivées", "archives")}</nav></div><button class="account" data-action="settings" aria-label="Étienne Laurent — Paramètres"><span class="avatar">EL</span><span>Étienne Laurent</span></button></aside><main class="main"><header class="topbar"><div class="breadcrumb">${state.collapsed ? ib("panel", "Ouvrir la navigation", "collapse") : ""}${i(state.page === "task" ? "folder" : "spark")}<span>${esc(state.page === "task" ? state.tasks[state.task].project : "Espace personnel")}</span><span class="slash">/</span><span class="task-title">${esc(state.page === "task" ? state.tasks[state.task].title : { new: "Nouvelle tâche", automations: "Automatisations", plugins: "Extensions", settings: "Paramètres", archives: "Archives" }[state.page])}</span></div><div class="top-actions"><span class="pill"><span class="dot"></span> Local</span>${state.page === "task" ? `${ib("branch", "Créer une branche de conversation", "fork")}${ib("archive", "Archiver cette tâche", "archive")}${ib("panel", "Afficher le panneau de travail", "panel")}` : ib("sun", "Changer de thème", "theme")}</div></header>${state.page === "task" || state.page === "new" ? workspace() : page()}</main><footer class="statusbar"><span class="dot"></span> Tous les systèmes opérationnels <span> ${state.environment === "Worktree" ? "⑂ muse/landing-page" : "⌂ Local"}</span><span class="right">Maquette interactive · Actions simulées</span><span>Muse-Desktop</span></footer></div>`;
  bind();
}
function workspace() {
  return `<div class="workspace"><section class="conversation"><div class="scroll" id="conversation-scroll">${state.page === "new" ? welcome() : conversation()}</div>${composer()}</section>${state.panel && state.page === "task" ? panel() : ""}</div>`;
}
function welcome() {
  return `<div class="welcome"><span class="muse-logo"><img src="../assets/muse-logo.png" alt="" aria-hidden="true"></span><h1>Vos idées.<br>Un peu plus loin.</h1><p class="muted">Construisez, explorez et livrez avec Muse.</p><button class="outline welcome-project" data-action="project">${i("folder")}${esc(state.project)}${i("down")}</button><div class="suggestions">${[
    [
      "code",
      "Créer une interface",
      "Crée une page d’accueil pour notre studio créatif.",
    ],
    [
      "search",
      "Explorer le projet",
      "Explique la structure du projet et les principaux composants.",
    ],
    [
      "check",
      "Revoir les changements",
      "Analyse les modifications et propose une revue de code.",
    ],
  ]
    .map(
      ([ic, t, p]) =>
        `<button data-suggestion="${esc(p)}">${i(ic)}${t}<br><small>Commencer avec Muse ↗</small></button>`,
    )
    .join("")}</div></div>`;
}
function conversation() {
  const t = state.tasks[state.task];
  return `<div class="eyebrow">${esc(t.project)} <span style="margin:0 7px">/</span> TÂCHE</div><h1>${esc(t.title)}</h1><div class="task-meta"><span>${state.running ? "En cours" : "Terminée"} · Aujourd’hui</span><span>⑂ muse/landing-page</span><span>${state.model}</span></div><div class="user-message">${esc(t.prompt)}</div><div class="message-head"><span class="muse-logo"><img src="../assets/muse-logo.png" alt="" aria-hidden="true"></span>Muse<small>${state.running ? "travaille sur votre demande" : "a travaillé pendant 1 min 24 s"}</small></div><div class="answer"><p>${state.task === 0 ? "Je vais créer une page épurée qui laisse toute la place à vos projets, en reprenant le design system existant." : "J’ai analysé votre demande dans le contexte du projet. Voici un exemple de déroulement pour cette maquette."}</p><div class="steps"><div class="step">${i("check")}Explorer le projet et ses composants<small>8 fichiers lus</small></div><div class="step">${i("check")}Implémenter la page et le responsive<small>3 fichiers modifiés</small></div><div class="step">${i("check")}Vérifier le rendu et les tests<small>12 / 12 réussis</small></div></div><p>La page est prête à être revue. Elle comprend une navigation adaptative, une introduction et une grille de projets. Les espacements et la typographie suivent les composants du projet.</p><div class="change-card"><header><span>${i("code")} Modifications proposées</span><button data-action="review">Voir les changements ${i("chevron")}</button></header><footer><span>3 fichiers modifiés</span><span><b class="green">+128</b> <b class="red">−24</b></span></footer></div><p class="muted" style="font-size:11px">${i("check")} Tous les tests passent · Aucun problème détecté</p><div class="message-actions">${ib("copy", "Copier la réponse", "copy")}${ib("undo", "Relancer la tâche", "rerun")}</div>${(state.messages[state.task] || []).map((m) => (m.role === "user" ? `<div class="user-message" style="margin-top:22px">${esc(m.text)}</div>` : `<p>${esc(m.text)}</p>`)).join("")}${state.running ? `<div class="approval"><b>Muse prépare les modifications…</b><p>Analyse du contexte et des composants du projet.</p><button class="outline" data-action="stop">Arrêter</button></div>` : ""}${state.approvalPending ? `<div class="approval"><b>Autoriser cette commande ?</b><p><code>npm run build</code><br>Exécuter la vérification dans le worktree du projet.</p><button class="primary" data-action="approve">Autoriser une fois</button><button data-action="deny">Refuser</button></div>` : ""}</div>`;
}
function composer() {
  return `<div class="composer-wrap"><div class="composer">${state.attachment ? `<div class="attachment">${i("file")}${esc(state.attachment)}${ib("close", "Retirer la pièce jointe", "detach")}</div>` : ""}<textarea id="prompt" aria-label="Message à Muse" placeholder="${state.page === "new" ? "Décrivez ce que vous voulez construire…" : "Demandez à Muse de poursuivre…"}">${esc(state.draft)}</textarea><div class="composer-footer">${ib("plus", "Joindre un fichier", "attach")}<select aria-label="Modèle" id="model">${["Muse Spark 1.3", "Muse Glimmer"].map((x) => `<option ${x === state.model ? "selected" : ""}>${x}</option>`).join("")}</select><select aria-label="Mode" id="mode">${["Agent", "Plan", "Discussion"].map((x) => `<option ${x === state.mode ? "selected" : ""}>${x}</option>`).join("")}</select><select aria-label="Environnement" id="environment">${["Worktree", "Local", "Cloud"].map((x) => `<option ${x === state.environment ? "selected" : ""}>${x}</option>`).join("")}</select><button class="send" data-action="send" aria-label="Envoyer le message" title="Envoyer · Entrée">${i("arrow")}</button></div></div><div class="composer-hint">${state.mode === "Plan" ? "Planifier avant de modifier" : "Muse travaille dans votre projet"} <span style="padding:0 6px">·</span> Entrée pour envoyer, Maj + Entrée pour une nouvelle ligne</div></div>`;
}
const files = [
  "src/app/page.tsx",
  "src/components/Navigation.tsx",
  "src/app/globals.css",
];
function panel() {
  return `<aside class="panel"><div class="panel-tabs">${[
    ["diff", "code", "Diff"],
    ["files", "folder", "Fichiers"],
    ["terminal", "terminal", "Terminal"],
    ["preview", "globe", "Aperçu"],
  ]
    .map(
      ([v, ic, t]) =>
        `<button data-panel="${v}" class="${state.panel === v ? "active" : ""}">${i(ic)}${t}</button>`,
    )
    .join(
      "",
    )}<button class="close" data-action="panel" aria-label="Fermer le panneau">${i("close")}</button></div><div class="panel-content">${panelContent()}</div><div class="panel-bottom"><span>${i("branch")} muse/landing-page</span><button class="primary" data-action="commit">${i("check")}${state.committed ? "Commit créé" : "Créer un commit"}</button></div></aside>`;
}
function panelContent() {
  if (state.panel === "terminal")
    return `<div class="terminal"><span class="muted">PowerShell · muse-web</span><p>❯ npm run test<br><span class="green">✓ Navigation.test.tsx (4 tests)<br>✓ Page.test.tsx (8 tests)<br><br>Test Files  2 passed (2)<br>Tests       12 passed (12)</span></p><div id="terminal-output"></div><label>❯ <input id="terminal-input" aria-label="Commande terminal" placeholder="Essayez npm run build"></label><p class="muted">Terminal de démonstration</p></div>`;
  if (state.panel === "preview")
    return `<div style="padding:12px 20px;font-size:11px;color:var(--muted)">◉ localhost:3000 <span style="float:right">Aperçu</span></div><div class="preview"><div class="demo-logo">ATELIER <span style="float:right;letter-spacing:0">Menu ☰</span></div><div class="demo-hero"><small>STUDIO CRÉATIF INDÉPENDANT</small><h2>De belles idées.<br>Un impact durable.</h2><p class="muted">Nous façonnons des identités et des expériences digitales singulières.</p><button class="primary" data-action="preview-projects">Nos projets ↗</button></div><div id="demo-projects"><div class="demo-art"></div><p>01 — Une nouvelle perspective</p></div></div>`;
  return `<div class="review-head"><h2>${state.panel === "files" ? "Explorateur du projet" : "Revue des modifications"}</h2><div class="review-summary"><span>3 fichiers modifiés</span><span class="green">+128</span><span class="red">−24</span><span class="pill">${state.committed ? "Commit créé" : "Non commité"}</span></div></div><div class="file-list">${files.map((f, k) => `<button class="file-row ${state.file === k ? "active" : ""}" data-file="${k}">${i("file")}${f}<span class="numbers"><span class="green">+${[86, 28, 14][k]}</span> <span class="red">−${[12, 8, 4][k]}</span></span></button>`).join("")}</div><div class="diff"><div class="diff-title">${i("file")}${files[state.file].split("/").pop()}<small>${state.panel === "files" ? "Lecture seule" : "Modifié"}</small></div><div class="code">${diffCode()}</div></div>`;
}
function diffCode() {
  const lines =
    state.file === 0
      ? [
          ["hunk", "@@ −1,12 +1,86 @@"],
          ["", 'import { Navigation } from "@/components";'],
          ["add", '+ import { ProjectGrid } from "@/components";'],
          ["", ""],
          ["", "export default function Home() {"],
          ["", "  return ("],
          ["del", '−   <main className="container">'],
          ["del", "−     <h1>Welcome to Atelier</h1>"],
          ["add", '+   <main className="min-h-screen">'],
          ["add", "+     <Navigation />"],
          ["add", '+     <section className="hero">'],
          ["add", '+       <span className="eyebrow">'],
          ["add", "+         STUDIO CRÉATIF INDÉPENDANT"],
          ["add", "+       </span>"],
          ["add", "+       <h1>"],
          ["add", "+         De belles idées."],
          ["add", "+         <br />"],
          ["add", "+         Un impact durable."],
          ["add", "+       </h1>"],
          ["add", "+       <ProjectGrid />"],
          ["add", "+     </section>"],
          ["", "    </main>"],
          ["", "  );"],
          ["", "}"],
        ]
      : state.file === 1
        ? [
            ["hunk", "@@ −1,8 +1,28 @@"],
            ["add", '+ "use client";'],
            ["add", '+ import { useState } from "react";'],
            ["", "export function Navigation() {"],
            ["add", "+ const [open, setOpen] = useState(false);"],
            ["", "  return ("],
            ["add", '+   <nav aria-label="Navigation principale">'],
            ["add", '+     <a href="/">ATELIER</a>'],
            ["add", "+     <button aria-expanded={open}"],
            ["add", "+       onClick={() => setOpen(!open)}>"],
            ["add", "+       Menu"],
            ["add", "+     </button>"],
            ["add", "+   </nav>"],
            ["", "  );"],
            ["", "}"],
          ]
        : [
            ["hunk", "@@ −1,4 +1,14 @@"],
            ["", ":root {"],
            ["add", "+ --color-ink: #182329;"],
            ["add", "+ --color-paper: #fafaf8;"],
            ["", "}"],
            ["add", "+ .hero {"],
            ["add", "+   padding: clamp(48px, 8vw, 120px);"],
            ["add", "+   max-width: 1440px;"],
            ["add", "+   margin-inline: auto;"],
            ["add", "+ }"],
            ["add", "+ @media (prefers-reduced-motion: reduce) {"],
            ["add", "+   * { scroll-behavior: auto; }"],
            ["add", "+ }"],
          ];
  return lines
    .filter(([c]) => state.panel !== "files" || c !== "del")
    .map(
      ([c, s], k) =>
        `<div class="${state.panel === "files" ? "" : c}"><span class="line-no">${c === "hunk" ? "" : k}</span>${esc(state.panel === "files" ? s.replace(/^\+ /, "") : s)}</div>`,
    )
    .join("");
}
function page() {
  if (state.page === "automations")
    return `<section class="page"><div class="page-head"><div><div class="eyebrow">VOTRE TRAVAIL, EN CONTINU</div><h1>Automatisations</h1><p class="muted">Confiez les tâches récurrentes à Muse.</p></div><button class="primary" data-action="add-auto">${i("plus")}Créer une automatisation</button></div><div class="cards">${state.automations.map((a, k) => `<article class="tile">${i("clock")}<h2>${esc(a.name)}</h2><p>${esc(a.prompt)}</p><span class="pill">${esc(a.schedule)}</span><footer><button data-auto="${k}" class="toggle ${a.on ? "on" : ""}" aria-label="${a.on ? "Désactiver" : "Activer"} ${esc(a.name)}" aria-pressed="${a.on}"></button><button data-edit-auto="${k}">Modifier ↗</button></footer></article>`).join("")}</div><p class="muted" style="font-size:11px;margin-top:25px">Les planifications sont enregistrées dans ce prototype. Aucune exécution en arrière-plan.</p></section>`;
  if (state.page === "plugins")
    return `<section class="page"><div class="eyebrow">UN ESPACE CONNECTÉ</div><h1>Donnez plus de possibilités à Muse.</h1><p class="muted">Vos outils, vos compétences, dans un même flux de travail.</p><input id="plugin-search" aria-label="Rechercher une extension" placeholder="Rechercher une extension…" style="padding:13px;border:1px solid var(--line);background:var(--surface);border-radius:10px;width:100%;margin:18px 0 26px"><div class="cards">${[
      ["GitHub", "branch", "Dépôts, issues et pull requests."],
      ["Figma", "grid", "Transformez vos designs en composants."],
      ["Navigateur", "globe", "Explorez et vérifiez vos interfaces."],
      ["Compétence UI", "spark", "Des conventions pour vos interfaces."],
      ["Linear", "check", "Retrouvez les tâches de votre équipe."],
      ["Documents", "file", "Créez et analysez vos documents."],
    ]
      .map(
        ([n, ic, d]) =>
          `<article class="tile" data-plugin-card="${n.toLowerCase()}">${i(ic)}<h2>${n}</h2><p>${d}</p><footer><small>${state.plugins.includes(n) ? "Activée dans la maquette" : "Extension"}</small><button class="outline" data-plugin="${n}">${state.plugins.includes(n) ? "Retirer" : "Ajouter"}</button></footer></article>`,
      )
      .join("")}</div></section>`;
  if (state.page === "archives")
    return `<section class="page"><h1>Tâches archivées</h1><p class="muted">Retrouvez les tâches que vous avez mises de côté.</p>${state.tasks.map((t, k) => (t.archived ? `<div class="settings-row"><span>${esc(t.title)}</span><button class="outline" data-restore="${k}">Restaurer</button></div>` : "")).join("") || "<p>Aucune tâche archivée.</p>"}</section>`;
  return `<section class="page" style="max-width:1000px"><div class="eyebrow">À VOTRE FAÇON</div><h1>Paramètres</h1>${[
    [
      "Apparence",
      "Personnalisez votre espace de travail.",
      `<select id="theme-setting" aria-label="Thème"><option value="light" ${state.theme === "light" ? "selected" : ""}>Clair</option><option value="dark" ${state.theme === "dark" ? "selected" : ""}>Sombre</option></select>`,
    ],
    [
      "Autorisations",
      "Demander une validation avant les actions sensibles.",
      '<span class="pill">À la demande</span>',
    ],
    [
      "Notifications",
      "Afficher les notifications de fin de tâche.",
      '<button class="toggle on" data-action="toggle-setting" aria-label="Notifications" aria-pressed="true"></button>',
    ],
    [
      "Contexte du projet",
      "Muse utilise les instructions et fichiers du projet.",
      '<span class="pill">AGENTS.md</span>',
    ],
    [
      "Raccourcis clavier",
      "Nouvelle tâche : Ctrl + N · Rechercher : Ctrl + K",
      "<kbd>⌘ / Ctrl</kbd>",
    ],
    [
      "À propos",
      "Maquette HTML, CSS et JavaScript. Données de démonstration.",
      '<span class="pill">Prototype 1.0</span>',
    ],
  ]
    .map(
      ([t, d, c]) =>
        `<div class="settings-row"><div><b>${t}</b><p>${d}</p></div>${c}</div>`,
    )
    .join("")}</section>`;
}
function bind() {
  document
    .querySelectorAll("[data-action]")
    .forEach((e) => (e.onclick = () => act(e.dataset.action)));
  document.querySelectorAll("[data-task]").forEach((e) => {
    if (state.tasks[+e.dataset.task].archived) e.classList.add("hidden");
    e.onclick = () => {
      state.task = +e.dataset.task;
      state.page = "task";
      state.project = state.tasks[state.task].project;
      state.approvalPending = false;
      shell();
    };
  });
  document.querySelectorAll("[data-project]").forEach(
    (e) =>
      (e.onclick = () => {
        state.project = e.dataset.project;
        state.page = "new";
        shell();
      }),
  );
  document.querySelectorAll("[data-panel]").forEach(
    (e) =>
      (e.onclick = () => {
        state.panel = e.dataset.panel;
        shell();
      }),
  );
  document.querySelectorAll("[data-file]").forEach(
    (e) =>
      (e.onclick = () => {
        state.file = +e.dataset.file;
        shell();
      }),
  );
  document.querySelectorAll("[data-suggestion]").forEach(
    (e) =>
      (e.onclick = () => {
        state.draft = e.dataset.suggestion;
        shell();
        document.querySelector("#prompt").focus();
      }),
  );
  document.querySelectorAll("[data-auto]").forEach(
    (e) =>
      (e.onclick = () => {
        let a = state.automations[+e.dataset.auto];
        a.on = !a.on;
        save();
        shell();
      }),
  );
  document
    .querySelectorAll("[data-edit-auto]")
    .forEach((e) => (e.onclick = () => autoModal(+e.dataset.editAuto)));
  document.querySelectorAll("[data-plugin]").forEach(
    (e) =>
      (e.onclick = () => {
        let n = e.dataset.plugin;
        state.plugins = state.plugins.includes(n)
          ? state.plugins.filter((p) => p !== n)
          : [...state.plugins, n];
        save();
        shell();
        toast("Extensions mises à jour dans la maquette");
      }),
  );
  document.querySelectorAll("[data-restore]").forEach(
    (e) =>
      (e.onclick = () => {
        state.tasks[+e.dataset.restore].archived = false;
        save();
        shell();
      }),
  );
  let ps = document.querySelector("#plugin-search");
  if (ps)
    ps.oninput = () =>
      document
        .querySelectorAll("[data-plugin-card]")
        .forEach(
          (c) =>
            (c.hidden = !c.dataset.pluginCard.includes(ps.value.toLowerCase())),
        );
  let prompt = document.querySelector("#prompt");
  if (prompt) {
    prompt.oninput = () => (state.draft = prompt.value);
    prompt.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };
  }
  ["model", "mode", "environment"].forEach((k) => {
    let el = document.getElementById(k);
    if (el)
      el.onchange = () => {
        state[k] = el.value;
        shell();
      };
  });
  let theme = document.querySelector("#theme-setting");
  if (theme)
    theme.onchange = () => {
      state.theme = theme.value;
      save();
      shell();
    };
  let term = document.querySelector("#terminal-input");
  if (term)
    term.onkeydown = (e) => {
      if (e.key === "Enter" && term.value.trim()) {
        const p = document.createElement("p");
        p.textContent =
          "❯ " +
          term.value +
          "\n" +
          (term.value.includes("build")
            ? "✓ Build de démonstration terminé en 1.8 s."
            : term.value.includes("test")
              ? "✓ 12 tests réussis (simulation)."
              : "Commande simulée. Essayez npm run build ou npm test.");
        p.style.whiteSpace = "pre-wrap";
        document.querySelector("#terminal-output").append(p);
        term.value = "";
      }
    };
}
function openModal(title, body, submit, label = "Enregistrer") {
  const d = document.querySelector("#modal");
  d.innerHTML = `<form method="dialog"><header><h2>${title}</h2><button value="cancel" formnovalidate aria-label="Fermer">${i("close")}</button></header>${body}<footer><button value="cancel" formnovalidate>Annuler</button>${submit ? `<button class="primary" id="modal-submit" value="default">${label}</button>` : ""}</footer></form>`;
  if (submit)
    d.querySelector("#modal-submit").onclick = (e) => {
      e.preventDefault();
      if (d.querySelector("form").reportValidity()) {
        submit(d);
        d.close();
      }
    };
  d.showModal();
}
function autoModal(k) {
  let a = state.automations[k] || {
    name: "",
    prompt: "",
    schedule: "Tous les jours · 09:00",
  };
  openModal(
    k === undefined ? "Nouvelle automatisation" : "Modifier l’automatisation",
    `<label for="auto-name">Nom</label><input id="auto-name" required value="${esc(a.name)}" placeholder="Ex. Revue quotidienne"><label for="auto-prompt">Instructions</label><textarea id="auto-prompt" required>${esc(a.prompt)}</textarea><label for="auto-schedule">Fréquence</label><select id="auto-schedule">${["Tous les jours · 09:00", "Lundi · 08:30", "Chaque heure"].map((s) => `<option ${s === a.schedule ? "selected" : ""}>${s}</option>`).join("")}</select>`,
    (d) => {
      let v = {
        name: d.querySelector("#auto-name").value,
        prompt: d.querySelector("#auto-prompt").value,
        schedule: d.querySelector("#auto-schedule").value,
        on: a.on ?? true,
      };
      if (k === undefined) state.automations.push(v);
      else state.automations[k] = v;
      save();
      shell();
      toast("Automatisation enregistrée");
    },
  );
}
function send() {
  if (state.running) return toast("Une réponse est déjà en cours");
  let text = state.draft.trim();
  if (!text) return;
  state.draft = "";
  if (state.page === "new") {
    state.tasks.push({
      title: text.length > 38 ? text.slice(0, 38) + "…" : text,
      prompt: text,
      project: state.project,
    });
    state.task = state.tasks.length - 1;
    state.page = "task";
    state.panel = "diff";
    save();
  } else {
    (state.messages[state.task] ??= []).push({ role: "user", text });
  }
  state.running = true;
  state.approvalPending = false;
  shell();
  let task = state.task;
  window.runTimer = setTimeout(() => {
    state.running = false;
    (state.messages[task] ??= []).push({
      role: "assistant",
      text:
        state.mode === "Plan"
          ? "Plan proposé : 1. Examiner les composants. 2. Appliquer les changements. 3. Vérifier le rendu et les tests. Vous pouvez passer en mode Agent pour poursuivre."
          : "Les modifications de démonstration sont prêtes. Vous pouvez consulter le diff et vérifier l’aperçu dans le panneau de travail.",
    });
    if (state.mode === "Agent") state.approvalPending = true;
    shell();
    document.querySelector("#conversation-scroll")?.scrollTo(0, 99999);
  }, 1400);
}
function act(a) {
  if (["automations", "plugins", "settings", "archives"].includes(a)) {
    state.page = a;
    shell();
    return;
  }
  switch (a) {
    case "new":
      state.page = "new";
      state.draft = "";
      shell();
      break;
    case "collapse":
      state.collapsed = !state.collapsed;
      shell();
      break;
    case "theme":
      state.theme = state.theme === "light" ? "dark" : "light";
      save();
      shell();
      break;
    case "panel":
      state.panel = state.panel ? null : "diff";
      shell();
      break;
    case "review":
      state.panel = "diff";
      shell();
      break;
    case "send":
      send();
      break;
    case "add-auto":
      autoModal();
      break;
    case "toggle-setting": {
      let b = document.querySelector('[data-action="toggle-setting"]');
      b.classList.toggle("on");
      b.setAttribute("aria-pressed", b.classList.contains("on"));
      break;
    }
    case "search":
      openModal(
        "Rechercher une tâche",
        '<input id="search-input" placeholder="Rechercher dans les projets…" aria-label="Rechercher une tâche" autofocus><div class="search-results"></div>',
      );
      {
        let inp = document.querySelector("#search-input"),
          results = document.querySelector(".search-results");
        let update = () => {
          results.innerHTML =
            state.tasks
              .map((t, k) =>
                t.title.toLowerCase().includes(inp.value.toLowerCase())
                  ? `<button type="button" data-result="${k}">${i("chat")}${esc(t.title)}<small>${esc(t.project)}</small></button>`
                  : "",
              )
              .join("") || '<p class="muted">Aucun résultat.</p>';
          results.querySelectorAll("button").forEach(
            (b) =>
              (b.onclick = () => {
                state.task = +b.dataset.result;
                state.page = "task";
                document.querySelector("#modal").close();
                shell();
              }),
          );
        };
        inp.oninput = update;
        update();
      }
      break;
    case "project":
      openModal(
        "Ouvrir un projet",
        '<p class="muted">Ajoutez un projet à cet espace de démonstration.</p><label for="project-name">Nom du projet</label><input id="project-name" required placeholder="mon-projet">',
        (d) => {
          state.project =
            d.querySelector("#project-name").value.trim() || "mon-projet";
          state.page = "new";
          shell();
        },
        "Ouvrir le projet",
      );
      break;
    case "fork": {
      let t = state.tasks[state.task];
      state.tasks.push({
        ...t,
        title: t.title + " · Variante",
        archived: false,
      });
      state.task = state.tasks.length - 1;
      save();
      shell();
      toast("Branche de conversation créée");
      break;
    }
    case "archive":
      state.tasks[state.task].archived = true;
      save();
      state.page = "archives";
      shell();
      toast("Tâche archivée — restaurable depuis les archives");
      break;
    case "commit":
      openModal(
        "Créer un commit",
        `<p>3 fichiers · <span class="green">+128</span> <span class="red">−24</span></p><label for="commit-message">Message du commit</label><input id="commit-message" required value="feat: add studio landing page"><p class="muted">Cette action simule un commit dans la maquette.</p>`,
        () => {
          state.committed = true;
          shell();
          toast("Commit simulé créé · a3f82c1");
        },
        "Créer le commit",
      );
      break;
    case "copy":
      navigator.clipboard
        ?.writeText(
          "La page est prête à être revue. Navigation adaptative, introduction et grille de projets.",
        )
        .then(() => toast("Réponse copiée"))
        .catch(() => toast("Copie indisponible dans ce navigateur"));
      break;
    case "rerun":
      state.draft = state.tasks[state.task].prompt;
      send();
      break;
    case "stop":
      clearTimeout(window.runTimer);
      state.running = false;
      shell();
      toast("Exécution arrêtée");
      break;
    case "approve":
      state.approvalPending = false;
      (state.messages[state.task] ??= []).push({
        role: "assistant",
        text: "Commande autorisée. Build de démonstration réussi : aucune erreur.",
      });
      shell();
      toast("Vérification terminée");
      break;
    case "deny":
      state.approvalPending = false;
      (state.messages[state.task] ??= []).push({
        role: "assistant",
        text: "Commande refusée. Les modifications restent disponibles pour revue.",
      });
      shell();
      break;
    case "attach": {
      let inp = document.createElement("input");
      inp.type = "file";
      inp.onchange = () => {
        state.attachment = inp.files[0]?.name || "";
        shell();
      };
      inp.click();
      break;
    }
    case "detach":
      state.attachment = "";
      shell();
      break;
    case "preview-projects":
      document
        .querySelector("#demo-projects")
        .scrollIntoView({ behavior: "smooth" });
      break;
  }
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["k", "n"].includes(e.key.toLowerCase())) {
    e.preventDefault();
    if (document.querySelector("#modal").open)
      document.querySelector("#modal").close();
    act(e.key.toLowerCase() === "k" ? "search" : "new");
  }
});
document.querySelector("#modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
shell();
