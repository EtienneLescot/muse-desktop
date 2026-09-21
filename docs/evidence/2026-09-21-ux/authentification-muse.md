# Authentification Muse dans l'éditeur — pourquoi, et comment (21 septembre 2026)

Question posée : « l'application gère du PowerShell et du Bash, donc pourquoi ne pas utiliser le CLI pour s'authentifier ? » **C'est la bonne réponse au problème**, et ce document explique pourquoi, avec les mesures qui l'établissent.

## Le problème, énoncé correctement

Le desktop **ne peut pas** s'authentifier seul :

| Constat | Preuve |
|---|---|
| MSP est un protocole `stdio` local, dans la session de l'utilisateur | `muse serve --help` : « The client owns this process's stdin and stdout and is its only connection » |
| Le schéma MSP n'a **aucune** notion d'authentification | Recherche exhaustive dans `@muse-code/sdk` : les seules occurrences de « token » sont le jeton d'approbation SS5 et la consommation LLM (`windowTokens`, `outputTokens`) |
| Aucun endpoint OAuth public Meta/Muse n'est exposé | Rien dans le schéma, rien dans l'aide du CLI |
| Le CLI est **déjà** authentifié | `~/.config/muse/auth.json` |

Donc un OAuth natif dans l'éditeur exigerait une API qui n'existe pas. Mais **le CLI a déjà le flux** :

```
muse login     Log in with your Meta account: approve a code in your browser.
               META_API_KEY always takes priority over the account login.
muse auth      Store provider API credentials
```

## Le CLI est pilotable — mesuré

| Vérification | Résultat |
|---|---|
| `muse login` fonctionne-t-il sans TTY ? | **Oui** — écrit sur stdout, identique sur trois exécutions |
| La sortie est-elle exploitable ? | **Oui** : URL et code sur des lignes séparées |
| Le PTY peut-il exécuter une commande ? | **Oui** — `writeTerminal(id, cmd + "\r")`, le chemin du bouton « Send » |
| Le PTY voit-il le `PATH` du CLI ? | **Oui** — `CommandBuilder` sans `env_clear`, donc héritage complet |

Sortie réelle capturée :

```
Open this page to sign in:
  https://auth.meta.com/oauth/device/?code=RVWJ-BCKT
confirm this code matches:
  RVWJ-BCKT

Waiting for approval…
```

Le processus a été tué pendant l'attente : **`auth.json` porte `mtime = 2026-09-19T18:47:36Z`**, antérieur à cette session. La vérification n'a rien modifié.

## Pourquoi c'est meilleur que de stocker les identifiants

Le jeton **ne traverse jamais l'éditeur**. L'utilisateur approuve dans son navigateur, et le CLI écrit lui-même dans son stockage. L'application ne fait que lancer une commande et lire une classification.

C'est structurellement plus sûr que toute alternative où l'éditeur deviendrait dépositaire d'un secret.

## Le piège que la fonctionnalité existe pour exposer

`muse login --help` documente que **`META_API_KEY` l'emporte toujours** sur le login de compte. Un éditeur qui se connecte pour utiliser son abonnement peut donc **continuer à consommer des crédits API sans aucun signal**.

C'est le cas que l'interface distingue explicitement :

| Situation | Message |
|---|---|
| `META_API_KEY` **et** identifiant stocké | **Avertissement** : le compte connecté est ignoré, retirer la variable |
| `META_API_KEY` seul | Neutre : la clé prime sur un login |
| Identifiant stocké seul | Neutre : se connecter remplace par un compte, ce qui utilise l'abonnement |
| Rien | Avertissement : appeler Muse échouera |

## Ce qui est livré

| Élément | Rôle |
|---|---|
| `muse_auth_status` (Rust) | Renvoie le mode effectif, la source, si la clé prime, et si le CLI est joignable |
| `src/lib/museAuth.ts` | Décision **pure** : libellés, tonalité, opportunité de proposer la connexion |
| Section « Muse authentication » | Affiche le mode, avec l'avertissement de priorité |
| Action « Sign in with Meta » | Ouvre le terminal et lance `muse login` |

**Le payload IPC ne peut pas transporter de secret**, et c'est vérifié à trois niveaux :

1. un test Rust asservit la **liste exacte des champs** et les **domaines de valeurs** ;
2. ce garde-fou est **vérifié par mutation** — un payload transportant la valeur échoue avec « the auth status payload changed shape » ;
3. `ux-auth-status.mjs` contrôle sur le pont réel que la valeur la plus longue fait **10 caractères** là où une clé en fait 48.

**Injection impossible** : `signInCommand()` renvoie `null` pour toute commande autre que la forme exacte revue. `rm -rf /` et `muse login; curl evil` sont testés.

## Deux erreurs de méthode, toutes deux attrapées

**Le premier garde-fou était faux.** Il cherchait des mots interdits dans le texte sérialisé et échouait sur `"mode":"api_key"` — une valeur d'énumération **légitime**. J'ai failli l'assouplir. La bonne lecture était que l'invariant est **structurel, pas lexical** : une liste blanche exacte de champs et des domaines de valeurs contraints. Une vérification par sous-chaîne ne peut pas distinguer « nommer un mode » de « transporter un secret ».

**Et le chemin du fichier d'identifiants a dû sortir du payload** parce qu'il faisait échouer ce même garde-fou. Le renderer n'en a pas besoin pour agir, et le garde-fou reste absolu au lieu d'accumuler des exceptions.

## Reste ouvert

- **Confirmer que le CLI ouvre le navigateur.** Son message dit « Open this page », ce qui suggère qu'il ne l'ouvre pas. Si c'est le cas, il faudra afficher l'URL pour que l'utilisateur la copie.
- **Détecter la fin de la connexion.** Aujourd'hui « Check again » est manuel ; un sondage pendant l'attente serait plus confortable.
- **`muse auth set`** n'est pas exposé, volontairement : il lit un secret sur stdin, ce que l'application ne doit pas manipuler.
