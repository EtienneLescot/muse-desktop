# M2-05 — passer de Local à Worktree, et revenir (plan, 22 septembre 2026)

## Ce qui est bloqué, et ce qui ne l'est pas

Le constat de la roadmap est que **MSP n'a pas de contrat multi-workspace** : un host sert un dossier, une session appartient à un host, et rien dans les 46 méthodes ne permet de déplacer une conversation d'un dossier à un autre. Ce constat reste vrai, et il ne changera pas côté client.

Mais il ne bloque qu'**une** des deux choses qu'on appelle « passer en worktree » :

| Besoin | Bloqué par MSP ? | Ce qui existe déjà |
|---|---|---|
| **Démarrer** une conversation dans un worktree | **non** | fait (PR #221) : `git_worktree_create_for_workspace` crée la copie sans session, puis la conversation démarre dedans |
| **Continuer** une conversation existante dans un worktree | **oui, si on entend « déplacer »** | la conversation appartient à son host ; on ne peut pas la transférer |
| **Continuer** dans un nouveau worktree | **non** | `Prepare handoff` compose déjà un plan en lecture seule + une note de passation bornée dans le composeur |

## La distinction qui rend le sujet faisable

« Déplacer » une conversation n'est pas nécessaire, et le simuler serait malhonnête. Ce qui est utile et possible :

**Ouvrir une nouvelle conversation dans le worktree, avec le contexte de la précédente.** L'ancienne reste intacte, à sa place, et le dit. C'est exactement ce que fait `Prepare handoff` aujourd'hui, sauf qu'il s'arrête à une note dans le composeur : il manque le dernier pas — créer le worktree et démarrer la session dedans.

Autrement dit : M2-05 se décompose en

1. **`Move to a worktree…`** sur une conversation ouverte : crée la worktree, ouvre **une nouvelle conversation** dedans, avec la note de passation en premier message. La conversation d'origine n'est ni vidée ni masquée ; l'interface annonce « a new conversation opens in the worktree; this one stays here ».
2. **`Back to the project folder`** : le chemin inverse, même mécanique, même honnêteté.
3. **Ne jamais présenter cela comme un déplacement.** Aucun état n'est transféré côté host : le transcript reste dans la conversation d'origine, et la nouvelle repart du contexte borné qu'on lui donne.

## Ce qu'il faut construire

- **Rien de nouveau côté Rust** : `git_worktree_create_for_workspace` (PR #221) suffit pour créer, et `startSessionInWorkspace` existe. `Prepare handoff` fournit déjà le plan, les conflits et les changements non commités.
- **Côté client** : une action dans l'en-tête de conversation, à côté de `Prepare handoff`, qui enchaîne plan → création → nouvelle conversation → note de passation. Elle doit réutiliser la **même** fabrication de nom que le démarrage (suffixe unique) : c'est le défaut mesuré ci-dessous.
- **Côté écran** : les mêmes étapes annoncées que sur l'écran d'accueil (copie, host, envoi), pour la même raison.

## Ce que la mesure a déjà appris

- **Collision de noms, rencontrée en vrai** : deux conversations du même projet demandaient `.muse/worktrees/openscreen` et la branche `muse/openscreen` ; la seconde s'est vu répondre `worktree path already exists`. Corrigé dans la même PR par un suffixe unique par conversation.
- **Le dépôt de l'utilisateur porte déjà ~70 worktrees** d'autres outils (Claude Code, Antigravity, Codex, opencode), tous nommés de façon unique — `claude/admiring-liskov-1d1098`, `wf_67e636b3-…`. La convention « un nom par conversation » est la norme, pas une exception.
- **La préparation est longue et muette** : c'est ce qui a mené à l'état de préparation annoncé (même PR). Toute action M2-05 devra l'utiliser, sinon elle reproduira le même silence.

## Ordre proposé

1. `Move to a worktree…` (nouvelle conversation + passation), avec les étapes annoncées.
2. `Back to the project folder`.
3. Retrait de la mention « bloqué » dans la roadmap, remplacée par ce qu'on sait faire — et par ce qu'on refuse de simuler.
