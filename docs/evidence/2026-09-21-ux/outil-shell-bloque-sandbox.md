# L'outil `powershell` du modèle ne revient jamais sous la sandbox Windows

**Mesuré le 23/09/2026** sur Windows 11, avec le sidecar Muse 1.3 (`target/debug/muse.exe`).
`muse sandbox windows check` → `backend=windows_elevated status=ready`, utilisateurs, capacités et
WFP prêts.

## Constat

Un tour qui demande au modèle d'exécuter `Get-ChildItem -Name` avec son outil `powershell` :

| Host | Posture | Résultat |
|---|---|---|
| lancé par l'app, projet demo-calc | `--sandbox-network restricted` | `toolCall` `inProgress` pendant 10 min puis `tool timed out` |
| externe (`probe-shell-turn.mjs`), dossier demo-calc | `--sandbox-network restricted` | aucun terminal en 90 s |
| externe, dossier temporaire neutre | `--sandbox-network restricted` | aucun terminal en 90 s |
| externe, même dossier | `--sandbox-network enabled` | aucun terminal en 90 s |
| externe, même dossier | `--disable-sandbox` | `completed` en **1 s**, sortie `a.txt`, tour terminé |

Aucun processus `powershell` n'est créé sous le host : l'outil bloque avant de lancer le shell.
Le `session/userShell` du composeur, lui, s'exécute sous la même sandbox (sonde
`msp-user-shell-items.mjs`) : seul l'outil `powershell` du modèle est touché.

**Conséquence** : en posture par défaut, Muse ne peut ni lancer de commande ni exécuter de tests
depuis l'app. Les outils de fichiers (lecture, recherche, édition, écriture) fonctionnent : sur le
même tour, après le timeout, le modèle a modifié `math.js` et créé `math.test.js`.

## Côté app (corrigé le 23/09)

- **Appels d'outils invisibles** : un item `toolCall` s'affichait comme un message assistant vide
  (« thinking… » pendant tout le blocage). Il devient une ligne d'outil nommée par son résumé
  (`powershell · List workspace file names`), marquée « running… » tant qu'il tourne, puis
  repliable avec sa sortie (`visibleOutput`) à la fin.
- **Arrêt** : `turn/interrupt` annule l'outil bloqué en 1 s et le host émet le terminal
  `cancelled` (sonde `probe-interrupt.mjs`, et rejoué dans l'app). Le fil affiche maintenant
  « Stopped ».
- **Une observation non reproduite** : un Stop à 4 min de blocage a remis l'app sur « Ready »,
  mais le host n'a enregistré aucune interruption et le tour a continué jusqu'au timeout, puis a
  édité les fichiers. Deux rejeux à 20 s d'attente se sont arrêtés proprement.

## Reste

- **Bug du host** (sandbox `windows_elevated` + outil `powershell`) à remonter à Muse. Contournement
  aujourd'hui : posture `elevated` (global « elevated » et projet `full`), qui désactive la
  sandbox.
- Rejouer un Stop après plusieurs minutes de blocage pour trancher l'observation ci-dessus.
