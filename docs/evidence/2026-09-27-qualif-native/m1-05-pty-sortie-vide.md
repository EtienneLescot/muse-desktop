# M1-05 — PTY interactif : la sortie ne revient jamais (27 septembre 2026)

**Constat : le cycle interactif du terminal ne fonctionne pas sur Windows réel.** L'écriture est
acceptée, le shell enfant tourne, mais **aucun octet de sortie ne revient jamais** — pas même la
bannière de démarrage de `cmd.exe`. Défaut reproductible, mesuré jusqu'au fil IPC.

## Mesure (webview empaquetée en dev, CDP 9222 — panneau Terminal)

Prérequis satisfaits (`scripts/ux-terminal-state.mjs --port 9222 --type "echo MUSE_PTY_MARK_27"`) :

```
session    : …
commande   : "echo MUSE_PTY_MARK_27"
Run in Muse: disabled=false
raison     : Run this command through the Muse host (userShell)
props      : {"canRunThroughMuse":true,"sessionId":"01a0c95f-…"}
```

Puis, sur le fil IPC (trace `window.fetch`) :

| Fait | Mesure |
|---|---|
| `terminal_open` | ✓ PTY ouvert (`term-5d56db6c-…`), meta « `C:\WINDOWS\system32\cmd.exe · \\?\G:\repos\openscreen` », taille 100×28 |
| Shell enfant | ✓ **PID 47560 `cmd.exe`, fils direct de muse-desktop.exe** (créé 15:50:35) |
| ConPTY pump | ✓ **`conhost.exe` PID 31468**, fils de muse-desktop.exe (même instant) |
| `terminal_write` | ✓ accepté ×2 — `{"input":"echo MUSE_PTY_MARK_27\\r"}`, `{"input":"echo MUSE_PTY_MARK_28\\r"}` (`write_all` + `flush` dans `terminal.rs`) |
| `terminal_read` | ✗ **~700 lectures consécutives : `{"output":"","done":false}` à chaque fois** |
| Bannière de démarrage de `cmd.exe` | ✗ **jamais reçue** (indépendant de toute écriture) |
| Redimensionnement (poke ConPTY) | ✗ `terminal_resize` 100→110 colonnes : sortie toujours vide |
| Côté UI | ✗ `.terminal-output` reste sur « Connected. Type a command below. » |

`done: false` constant = le thread lecteur (`muse-terminal-reader`) est vivant et **bloqué dans
`reader.read()`** ; le pipe de sortie ConPTY ne livre rien.

## Ce qui est écarté (diagnostic différentiel)

- **Câblage applicatif : correct.** `src-tauri/src/terminal.rs` suit le patron canonique
  `openpty → spawn_command → drop(slave) → try_clone_reader → take_writer → thread lecteur` ;
  `write()` fait `write_all + flush` ; `OutputBuffer::append/drain` est couvert par des tests
  Rust verts (`cargo test` : bornage et drain).
- **Spawn en échec silencieux : écarté** — `cmd.exe` **et** `conhost.exe` sont vivants.
- **Problème d'entrée : écarté** — la bannière de démarrage seule devrait apparaître sans entrée.
- **Quirck ConPTY « flush après resize » : écarté** — le redimensionnement réel ne change rien.

## Piste de cause racine (externe, corroborante)

Le `Cargo.lock` verrouille **`portable-pty 0.9.0`** — la version exacte qu'un correctif de
turborepo décrit comme introduisant un **gel de TUI Windows par changements ConPTY** :
[vercel/turborepo#11816 — « Resolve Windows TUI hang caused by portable-pty 0.9.0 ConPTY changes »](https://github.com/vercel/turborepo/pull/11816).
Voir aussi [wezterm/wezterm#1396](https://github.com/wezterm/wezterm/issues/1396) et
[wezterm/wezterm#7025](https://github.com/wezterm/wezterm/issues/7025) pour le comportement
`portable-pty` sur Windows.

**Remédiation proposée :** essayer `portable-pty 0.8.x` (ou la version corrigée utilisée par
turborepo) puis rejouer exactement ce scénario ; l'entrée de benchmark est fixée ici.

## Verdict M1-05 Windows

**Non clos — et le ticket a un vrai défaut, pas seulement une preuve manquante.** Ce qui marche :
ouverture PTY, shell réel lié au cwd, écriture lossless, resize, fermeture contrôlée, états et
raisons affichés (« Run this command through the Muse host (userShell) »). Ce qui ne marche pas :
**toute la sortie**, donc l'interactivité, le rendu ANSI et les raccourcis ne sont pas
qualifiables en l'état.

## Reproductibilité

- Commit `2c11ee3` ; Windows 11 26200, WebView2 ; sidecar `muse-bin-1.3.0-R3401.1`.
- Séquence : `node scripts/ux-terminal-state.mjs --port 9222 --type "echo …"` → soumission via
  `.terminal-input button[type=submit]` → lecture `terminal_read` (trace `window.fetch`).
- Env : Windows 11 build 26200 ; crate verrouillée `portable-pty 0.9.0`.
