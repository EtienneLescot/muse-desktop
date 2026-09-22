# Sous-agents : audit, et ce qui se passe le jour où on en demande vraiment (22 septembre 2026)

Déclencheur : un bloc « Agent … Reminder child session » dont **les six boutons échouaient**, avec une erreur générique en haut de page. La cause immédiate était un nom de champ inventé (`agentId` au lieu de `subagentId`, corrigé dans la PR #224). Restait la vraie question : **qu'est-ce qui est réellement en place, et comment ça marchera le jour où on veut des sous-agents ?**

## 1. Le client ne peut pas créer de sous-agent. Jamais.

Le schéma MSP exporté par le binaire 1.3.0 expose **huit** méthodes `subagent/*` :

| Méthode | Ce qu'elle fait |
|---|---|
| `subagent/interrupt` | interrompt l'enfant |
| `subagent/stop` | l'arrête |
| `subagent/resume` | le reprend |
| `subagent/followupTask` | lui envoie une nouvelle instruction (`body`) |
| `subagent/readResult` | lit son résultat |
| `subagent/close` | le ferme |
| `subagent/reopen` | le rouvre |
| `subagent/sendMessage` | lui envoie un message |

**Aucune méthode de création.** Ni `spawn`, ni `start`, ni `create`. La liste complète des 46 méthodes du contrat n'en contient aucune. Créer un sous-agent est donc une décision **du modèle pendant son tour**, pas une commande du client. Les huit méthodes ci-dessus ne font que *piloter* ce qui existe déjà.

Conséquence directe pour l'interface : **tout bouton qui laisserait croire qu'on lance un sous-agent mentirait.** Ce qu'on peut honnêtement offrir, c'est *demander* au modèle de déléguer — c'est-à-dire du texte — puis piloter et observer ce qui en résulte.

## 2. Ce que le client utilise réellement, sur les huit

| Méthode | Appelée par le client ? |
|---|---|
| `subagent/interrupt` · `stop` · `resume` · `followupTask` · `readResult` | oui (les six contrôles du bloc) |
| `session/read` pour « Agent conversation » | oui |
| `subagent/close` · `subagent/reopen` · `subagent/sendMessage` | **non, jamais** |

Les trois non utilisées ne sont pas forcément nécessaires — mais elles existent, et l'audit doit dire pourquoi on ne les prend pas, ou les prendre. `close` en particulier a un sens produit évident : un enfant fini qui traîne dans la lane.

## 3. Le faux positif, nommé

Le bloc se présentait comme une console de contrôle opérationnelle. Il ne l'était pas :

- **les six boutons échouaient tous** (mauvais champ), donc rien de ce qui était offert ne fonctionnait ;
- **les boutons ne tenaient compte d'aucun état** : sur un agent `Completed`, « Interrupt » et « Stop » restaient cliquables — or il n'y a plus rien à interrompre ;
- **l'échec s'affichait en bandeau global**, en haut de la page, alors qu'il concernait ce bloc ;
- **l'identifiant enfant brut** (`child: 7d2adb74-1fa9-4316-9fb9-397055ee3809`) n'apprenait rien.

## 4. Ce qui est corrigé dans cette PR

1. **Une table de disponibilité** (`subagentControlAvailability`, pure et testée) remplace les booléens ad hoc. Elle ne désactive que là où la raison est **certaine** — on ne peut pas interrompre un agent fini — et chaque contrôle désactivé porte **sa phrase** (« This agent has finished; there is nothing to interrupt. »).
   - Délibérément, `readResult` et `followupTask` restent disponibles sur un agent fini : on n'a **aucune mesure** disant que le host les refuse, et deviner serait reproduire le défaut qu'on corrige.
2. **Le libellé de la session enfant** : le titre quand le client le connaît (identifiant conservé en infobulle), sinon un identifiant raccourci (`7d2adb74…`) — pas un UUID de 36 caractères.

## 5. Ce qui reste ouvert, et qui demande une décision ou une mesure

| Point | Nature |
|---|---|
| **L'erreur dans le bloc, pas en haut de page** | demande un état d'erreur par entrée ; le bandeau global reste pour la conversation. Non fait ici. |
| **`subagent/close`** | à exposer ? Un enfant fini qui s'accumule dans la lane est un vrai sujet d'UX. |
| **`followupTask` sur un agent fini** | **à mesurer** avant de le promettre ou de l'interdire. |
| **Demander une délégation** | le client ne peut que demander ; `/fanout` le fait déjà en langage naturel. À aligner avec ce vocabulaire plutôt qu'à inventer un bouton « spawn » qui n'existe pas dans le contrat. |

## 6. La réponse à « le jour où on demande à spawner »

**Mécanique :** on ne spawne pas. On écrit une demande de délégation dans le tour ; le modèle décide ; le host publie les items `subagent` ; le client pilote (8 méthodes) et observe (lanes). Toute mécanique qui prétendrait le contraire serait une simulation.

**UX :** le vocabulaire doit dire « demander », pas « lancer ». Et la lane sous-agent doit rendre trois choses lisibles : qui a été délégué (titre, pas UUID), où il en est (statut du host), et ce qu'on peut encore faire (les contrôles, avec leurs raisons).
