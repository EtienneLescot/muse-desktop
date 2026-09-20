# Le host émet bien le terminal après une interruption (20 septembre 2026)

**Ce document corrige l'écart n° 2 de [`SIDECAR-CONTRACT-GAPS.md`](../../SIDECAR-CONTRACT-GAPS.md)**, qui affirmait qu'aucune notification terminale n'est émise après `turn/interrupt`. **C'est faux**, et j'ai trouvé pourquoi je le croyais.

## La mesure

```powershell
node scripts/msp-interrupt-notifications.mjs
```

Un tour délibérément long est lancé, puis interrompu après 6 s avec `{sessionId, turnId, commandId}`, et **toutes** les notifications sont enregistrées pendant 45 s.

**Résultat — le host est bavard, et vite :**

| Après l'interruption | Notification |
|---|---|
| +19 ms | `item/completed` |
| +39 ms | `session/statusChanged` |
| **+39 ms** | **`turn/completed`** |
| deltas `item/delta` ensuite | **0** — le tour s'est bien arrêté |

Le terminal porte **exactement le `turnId` attendu** :

```json
{ "method": "turn/completed",
  "turnId": "01a0c05a-2e5d-77e9-863a-97b400bf52c1",
  "keys": ["sessionId", "viewCursor", "sourceRange", "turnId", "terminal", "reason", "durationMs"] }
```

(`turnId` envoyé et `turnId` reçu sont identiques.)

## Pourquoi je croyais le contraire

`native-smoke.mjs --exercise-control --exercise-terminal` **échoue**, avec :

```
host-A did not emit a terminal notification for …
```

Ce n'est **pas** le host qui est en cause. La ligne fautive est dans le harness :

```js
await host.request("turn/interrupt", {
  commandId: uuidv7(),
  sessionId: sessions[index],
  retract: false,          // ← pas de turnId
});
```

**Le host exige `turnId`** — il le dit lui-même : `invalid session/start commandId: expected UUIDv7`, et pour l'interruption `turn/interrupt` exige `commandId` **en plus de** `turnId` (déjà noté au §« détails de forme » du rapport). Sans `turnId`, l'interruption est refusée en `invalidParams`, **le tour n'est jamais interrompu**, et aucun terminal ne peut arriver.

Le harness traduisait ensuite cette absence en `terminalNotification: unsupported`, et **j'ai pris ce constat pour une propriété du host**. C'est la **quatrième** erreur de la même famille dans cette campagne : une erreur de méthode lue comme une absence de capacité.

## Ce que le client fait, lui

Le code Rust **sait** envoyer le `turnId` — mais il est **optionnel** :

```rust
if let Some(turn_id) = turn_id.map(str::trim).filter(|value| !value.is_empty()) {
    params["turnId"] = json!(turn_id);
}
```

Et son commentaire énonce exactement l'intention du client :

> An accepted `turn/interrupt` is admission only; the renderer remains in its stopping state until `turn/completed`, `turn/retracted` or another terminal notification arrives.

**Donc le client attend délibérément un terminal — et le host le fournit**, à condition que le `turnId` soit transmis.

## Ce qui reste à vérifier, et qui n'est plus un écart sidecar

L'interface a bel et bien montré un `Stopping…` qui ne se résolvait pas, avec le bandeau « waiting for the desktop host to confirm it ». **Quelque chose ne fonctionne pas sur ce chemin** — mais ce n'est **pas** l'absence de terminal côté host, c'est démontré.

Trois possibilités, aucune tranchée :

1. le renderer n'appelle pas `interrupt_session` avec un `turnId` non vide, donc le host refuse ou interrompt autre chose ;
2. le terminal arrive mais n'est pas associé au bon tour côté client ;
3. l'observation d'interface datait d'un état différent.

**Ce qu'il faudrait pour trancher :** reproduire l'arrêt depuis l'interface avec l'onglet réseau ou une trace des appels Rust, et vérifier **le `turnId` effectivement transmis**.

## Vérification du harness

```powershell
node scripts/native-smoke.mjs --exercise-control --exercise-terminal
# échoue : "did not emit a terminal notification" — harness sans turnId

node scripts/msp-interrupt-notifications.mjs
# réussit : turn/completed à +39 ms
```

**Le harness a besoin d'un correctif** : passer le `turnId` du tour qu'il interrompt. Tant qu'il ne le fait pas, il continuera de produire un faux constat d'absence, et toute documentation qui s'appuie sur lui sera fausse — comme la mienne l'a été.

## Bilan des corrections de ce rapport

| Écart | Ce que j'affirmais | Mesuré |
|---|---|---|
| 1 | `session/read` et `session/resume` absents | **présents et fonctionnels** sur une session persistée |
| 2 | aucun terminal après interruption | **`turn/completed` à +39 ms** |
| 5 | `sessionDurability` constamment `ephemeral` | **variable** : `ephemeral` puis `durable` |

**Trois écarts sur cinq étaient faux**, tous pour la même raison : mon outillage ne distinguait pas « la ressource n'existe pas » de « mon scénario ne la sollicitait pas ».
