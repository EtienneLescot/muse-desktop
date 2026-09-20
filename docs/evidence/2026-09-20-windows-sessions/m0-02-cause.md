# M0-02 : ce qui est vraiment en cause (20 septembre 2026)

Après [`reprise-fonctionne.md`](reprise-fonctionne.md), qui a montré que le host sait reprendre une session persistée, ce document cherche **qui** échoue. Il écarte deux hypothèses et en laisse une, sans conclure au-delà de ce qui est mesuré.

## Hypothèse 1 — le gate `ephemeral` du client : **écartée**

Le client refuse la reprise quand sa session stockée est marquée `ephemeral`, à **deux endroits** :

```ts
// useMuseSessions.ts, reconnectSession
if (isEphemeralSession(session)) { /* erreur, return */ }

// bootResume.ts, isResumeEligible
if (session.session_durability?.toLowerCase() === "ephemeral") return false;
```

avec

```ts
function isEphemeralSession(session) {
  return session?.session_durability?.toLowerCase() === "ephemeral";
}
```

**Cette valeur n'est écrite qu'à la création de la session** (six sites d'écriture, tous alimentés par `meta.session_durability` du host) et **jamais révisée**.

**Tests menés :**

| Vérification | Résultat |
|---|---|
| Durabilité stockée dans les 41 sessions de la sauvegarde | **41 × `durable`**, aucune `ephemeral` |
| Durabilité stockée dans la session restante | **`durable`** |
| Durabilité annoncée par le host aujourd'hui | **`durable`** |

**Le gate ne s'est donc jamais déclenché** : aucune session locale n'a jamais porté `ephemeral`. Je **ne peux pas** lui attribuer l'échec de reprise constaté pendant la campagne.

Le gate reste un **risque latent** — si la durabilité du host change, une session marquée `ephemeral` à sa création refuserait la reprise pour toujours, alors même que le host serait devenu durable. Mais **je n'ai aucune preuve que ce cas se soit produit**, et je n'ai donc **rien corrigé** à ce titre.

## Hypothèse 2 — le client n'utilise pas `session/list` : **confirmée, mais pas causale**

`session/list` figure dans `MSP_METHODS_SENT` (`src/lib/msp.ts` ligne 32), la liste des méthodes que le Rust envoie. Mais côté application, **aucun appel** :

| Occurrence dans `src/` | Nature |
|---|---|
| `msp.ts:32` | déclaration dans la liste des méthodes |
| `App.tsx:386` | un **commentaire** qui la mentionne |

**Le client ne demande donc jamais au host quelles sessions existent.** Il ne peut pas découvrir une session que le host connaît mais que le stockage local ignore, ni réconcilier un identifiant après un redémarrage.

**Est-ce la cause de l'échec observé ?** Pas démontré. C'est une **capacité manquante**, pas un défaut prouvé.

## Hypothèse 3 — la session n'avait jamais été persistée : **la plus probable**

`msp-resume-free-session.mjs` a montré qu'une session **ne se persiste qu'en écrivant un tour** : le host A en listait 10, le host B **9** — la session créée sans tour avait disparu.

L'échec documenté dans le README de campagne portait sur la session `01a0bd8e`, active pendant la campagne. Plusieurs des sessions de cette campagne ont été créées et utilisées **sans tour abouti** (le nettoyage l'a montré : des coquilles à `turnCount: 0`).

**Si la session n'a jamais été écrite sur disque, aucun host ne peut la reprendre** — et `sessionNotFound` est alors la **réponse correcte**, pas un défaut.

**Je n'ai pas pu le vérifier pour `01a0bd8e` en particulier** : la session a été supprimée pendant le nettoyage. C'est une hypothèse étayée par un mécanisme mesuré, pas une preuve sur ce cas précis.

## Ce qui est établi, et ce qui ne l'est pas

| Affirmation | Statut |
|---|---|
| Le host sait reprendre une session persistée et libre | **prouvé** — `session/resume` réussit, `session/read` répond |
| Une session sans tour abouti ne se persiste pas | **prouvé** — 10 sessions chez A, 9 chez B |
| Le client n'appelle jamais `session/list` | **prouvé** — aucune occurrence d'appel dans `src/` |
| Le gate `ephemeral` a bloqué une reprise | **non prouvé, et contredit** par les 41 × `durable` stockés |
| L'échec de campagne venait d'une session non persistée | **probable, non prouvé** — le mécanisme est mesuré, le cas précis ne l'est pas |

## Ce que je n'ai pas fait, et pourquoi

Je n'ai **rien corrigé dans le code**. Deux raisons :

1. **Aucun défaut n'est prouvé.** Le gate ne s'est jamais déclenché, et l'absence d'appel à `session/list` est une capacité manquante, pas un bug démontré.
2. Le chemin de reprise touche la **récupération des conversations**. Y introduire un changement non prouvé, sans pouvoir reproduire le défaut d'origine, serait exactement le genre de correctif que cette campagne a passé son temps à réfuter ailleurs — comme le correctif `prefers-contrast` tenté puis retiré.

**Ce qui serait à faire, si le sujet est repris :** reproduire l'échec de reprise **d'abord** — une session avec un tour abouti, l'application fermée, le host tué, puis une tentative de reprise depuis l'interface. Tant que ce scénario n'échoue pas de façon reproductible, il n'y a rien à corriger.

## Reproductibilité

```powershell
node scripts/msp-resume-free-session.mjs   # prouve que le host sait reprendre
node scripts/msp-session-survival.mjs      # prouve qu'une session sans tour ne persiste pas
node scripts/msp-list-sessions.mjs         # liste ce que le host connaît
```
