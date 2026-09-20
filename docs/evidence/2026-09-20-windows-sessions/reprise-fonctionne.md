# La reprise fonctionne côté host : M0-02 est un écart client (20 septembre 2026)

**Ce document corrige les écarts n° 1 et n° 2 de [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md).** Les deux étaient faux, et le test qui les contredit est décisif.

## Le test

```powershell
node scripts/msp-resume-free-session.mjs
```

Séquence complète, sans application lancée :

1. host **A** neuf → `session/start` avec un `commandId` UUIDv7 ;
2. un tour **réel** est mené à son terme, pour que la session soit écrite sur disque ;
3. **host A est tué** — l'équivalent d'une fermeture d'application ou d'un plantage ;
4. host **B** neuf → `session/list`, puis **`session/resume`** sur la session, **libre** cette fois ;
5. `session/read` pour vérifier que l'historique est accessible.

## Résultat

| Étape | Résultat |
|---|---|
| Tour achevé sur A | **`turn/completed` reçu** |
| Host B liste la session | **oui** — `status: notLoaded`, `turnCount: 1` |
| **`session/resume` sur session libre** | **succès** |
| `session/read` | **succès** — retourne `history`, `viewCursor`, `session`, `pendingRequests` |

Notifications observées sur le tour nominal de A :

```
session/started, session/branchChanged, session/statusChanged,
turn/started, item/started, item/delta, item/completed,
session/tokenUsage, session/contextUsage, turn/completed
```

## Les deux corrections

### Écart n° 1 — `session/read` et `session/resume` ne sont pas absents

Le rapport les classait `unsupported` et en faisait le **premier chantier à demander au sidecar**. **Faux.**

La cause était dans ma sonde : `msp-probe.mjs` appelait ces surfaces sur une session **fraîchement créée**, jamais persistée → `sessionNotFound`, que la sonde ne distinguait pas de `methodNotFound`.

Sur une session **persistée et libre** : `session/read` répond `ok`, **`session/resume` répond succès**.

**Conséquence : la reprise durable fonctionne au niveau du host.** Le blocage de M0-02 n'est **pas** dans le sidecar.

### Écart n° 2 — `turn/completed` **est** émis

Le rapport affirmait que les notifications terminales ne sont **jamais** émises. **Faux.**

| Situation | Terminal |
|---|---|
| Tour mené à son terme | **`turn/completed` émis** |
| Tour interrompu par `turn/interrupt` | **aucun** — `native-smoke --exercise-control --exercise-terminal` échoue : `host-A did not emit a terminal notification` |

**Cause de mon erreur :** `native-smoke.mjs` ne teste la notification terminale **qu'après une interruption**. Je n'avais jamais mesuré le cas nominal et j'ai généralisé.

**Ce qui manque réellement :** la confirmation d'un **arrêt demandé**. L'utilisateur appuie sur Stop, le host accuse, puis rien ne confirme que le tour s'est arrêté. C'est plus étroit que « aucune notification terminale ».

## Ce que cela change pour M0-02 et M0-04

| Ticket | Ce que je croyais | Ce qui est mesuré |
|---|---|---|
| **M0-02** (reprise) | bloqué par l'absence de `session/read` et `session/resume` | **le host sait reprendre une session persistée.** Le défaut est **côté client** : `session/list` est déclaré dans `src/lib/msp.ts` ligne 32 mais **jamais appelé**, et rien ne réconcilie les conversations locales avec les sessions que le host connaît |
| **M0-04** (arrêt fiable) | bloqué par l'absence de toute notification terminale | seul le **chemin d'arrêt** manque de terminal ; le chemin nominal en a un |

**M0-02 n'est donc pas un chantier sidecar.** C'est un défaut corrigeable dans ce dépôt — le plus prometteur que j'aie trouvé depuis le début de la campagne.

## Trois erreurs, une seule cause

Mon rapport s'est trompé **trois fois** :

1. `session/read` / `session/resume` « absents » — la sonde testait une session non persistée ;
2. `sessionDurability` constante `ephemeral` — sa valeur a changé en cours de campagne ;
3. notifications terminales « jamais émises » — la sonde ne testait que le chemin d'interruption.

**La même cause à chaque fois : une erreur de contexte interprétée comme une absence de capacité.** Une sonde qui ne distingue pas « la ressource n'existe pas » de « mon scénario ne la sollicitait pas » produit des constats d'absence qui sont en réalité des constats de méthode.

## Ce qui reste à faire

- **Vérifier le chemin client** : où le client échoue-t-il, et peut-il appeler `session/list` puis `session/resume` pour réconcilier ? C'est du code de ce dépôt.
- **`view/page`** : le `viewCursor` retourné par `session/read` en tient peut-être lieu.
- **Le terminal après interruption** : le seul écart sidecar confirmé de ce document, avec `session/userShell` §3 et les projections §4.

## Reproductibilité

```powershell
node scripts/msp-list-sessions.mjs          # sessions persistées
node scripts/msp-session-survival.mjs       # survie à la mort du host
node scripts/msp-resume-free-session.mjs    # reprise sur session libre (ce document)
```

Les trois sont en **lecture seule** — sauf le second et le troisième, qui créent une session et un tour trivial pour rendre la persistance observable.
