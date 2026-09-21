# M1-06 — le « constat bloquant » était un artefact de mesure (21 septembre 2026)

**Verdict : le blocage attribué au host n'existe pas.** `session/userShell` exécute la commande et publie son résultat. Le « constat bloquant » du 19 septembre venait d'une sonde qui demandait la capacité sous une forme que le host lit comme « aucune capacité demandée ».

## Ce que la roadmap affirmait

> **Constat bloquant (Windows, 19/09/2026) :** `--exercise-user-shell --exercise-user-shell-slow` a obtenu `accepted` des deux côtés, mais **aucun** `item/started`, aucune notification portant le `commandId`, et aucun fichier témoin 14 s après l'admission. L'admission seule ne prouve ni exécution ni restitution — **le blocage est côté host**.

Cette phrase a orienté la campagne : elle classe M1-06 parmi les tickets qu'« aucune correction client ne fermera », et renvoie vers `SIDECAR-CONTRACT-GAPS.md`.

## La cause : une clé de capacité mal placée

`scripts/msp-user-shell-items.mjs` envoyait :

```js
capabilities: {},                        // vide
requestedCapabilities: ["userShell"],    // au premier niveau
```

L'application envoie, depuis toujours (`src-tauri/src/main.rs`) :

```rust
"capabilities": {"requestedCapabilities": ["userShell"]}
```

La clé doit être **imbriquée**. Avec la forme à plat, le host ne voit aucune capacité demandée : il n'accorde rien, et répond à l'appel par `capabilityRequired`. La sonde en concluait qu'aucun item n'est publié — alors qu'**elle n'avait jamais exécuté la commande**.

C'est aussi pourquoi le bureau, lui, accorde `userShell` et active le bouton : il utilisait la bonne forme. **Deux mesures du même contrat se contredisaient, et c'est la mauvaise qui a été publiée.**

## Mesures, avant et après correction

| | Forme à plat (fausse) | Forme imbriquée (celle de l'application) |
|---|---|---|
| `grantedCapabilities` | `[]` | **`["userShell"]`** |
| `session/userShell` | `failed`, `capabilityRequired` | **`accepted`**, `commandId` renvoyé |
| Notifications | **aucune** | **`item/started`** puis **`item/completed`**, type `userShell`, à 1 867 et 1 922 ms |
| Sortie de la commande | — | **marqueur restitué** (`markerEchoed: true`) |
| Verdict de la sonde | « the gap is confirmed outside the suspect harness » | « **the host DOES publish 2 userShell item(s) — the gap report is wrong here** » |

Le script portait déjà, dans son propre commentaire, l'avertissement que la réclamation venait d'un harnais **déjà prouvé faussement négatif** ([`harness-faux-negatif.md`](../2026-09-20-windows-sessions/harness-faux-negatif.md)). Il a reproduit le même défaut de méthode en changeant de cause.

## Ce qui reste vrai, et ce qui ne l'est plus

**Réfuté :** « le host ne publie pas d'item `userShell` ». Il en publie deux, avec la sortie.

**Confirmé, mais c'est le client :** la sortie n'est **pas rendue dans le transcript**. `BETA-0.1.0-SCOPE.md` disait déjà l'exact inverse du blocage — « le host fournit l'item, le client ne l'affiche pas » — et c'est cette lecture qui est juste. Le repli « Add output to prompt » fonctionne.

**Confirmé, autre cause :** `Run in Muse` échoue en `sessionNotLoaded` sur une conversation jamais lancée. Le host **admet** la session au repos (elle figure dans `session/list`) mais ne la **charge** qu'à son premier tour. Le client active le bouton dans cet état et l'échec n'arrive qu'après le clic.

**À revérifier :** M0-04 et M1-11 s'appuyaient sur le même harnais (`--exercise-user-shell`), dont la forme de capacité était fausse. Leur blocage doit être remesuré avant d'être cité à nouveau.

## Le chemin client, vérifié de bout en bout

| Étage | Mesure |
|---|---|
| Projection Rust | `restore_sessions` renvoie `granted_capabilities: ["userShell"]` pour les 11 sessions |
| Fusion renderer | `grantedCapabilitiesBySession` (hook #82) contient `["userShell"]` pour la session active |
| Prop React | `canRunThroughMuse` passe à **`true`** dès qu'une commande est saisie |
| Bouton | `disabled=false`, infobulle « Run this command through the Muse host (userShell) » |
| Appel | atteint le host, qui répond `sessionNotLoaded` — l'échec est **réel** et **rapporté** |

**Une note de méthode sur ce dernier point.** Un tour précédent a conclu que ce bouton était bloqué par la capacité. C'était faux : `disabled` combine trois conditions (`!canRunThroughMuse || !command.trim() || runningThroughMuse`), et j'avais lu le `disabled` d'un champ **vide**. Le marqueur qui tranche est l'**infobulle**, qui change selon la cause : « did not grant the userShell capability » en cas de capacité manquante, « Run this command through the Muse host (userShell) » sinon. **Mesurer la cause, pas l'état composite.**

## Instruments

| Script | État |
|---|---|
| `msp-user-shell-items.mjs` | **corrigé** — forme de capacité imbriquée, avec le pourquoi en commentaire |
| `ux-run-in-muse.mjs` | exerce le chemin UI : saisie, activation, clic, attente de l'item |
| `ux-read-logs.mjs` | lit le transcript depuis l'état du hook, pas depuis le DOM |
| `ux-terminal-state.mjs` | lit l'état des deux actions d'envoi **et la raison** de leur indisponibilité : distingue « échec » de « jamais tenté » |
| `check-scripts-parse.mjs` | garde-fou : tout script de `scripts/` doit au moins compiler |
