# Premier lancement : guidance d'échec exercée — M0-10 (20 septembre 2026)

Test volontairement destructif sur les prérequis de démarrage, avec **restauration vérifiée**. Autorisation explicite de l'utilisateur.

## Comment casser le démarrage pour de vrai — deux découvertes

Les deux ont été nécessaires, et la première a invalide un premier essai :

1. **Tauri copie le sidecar au moment du build.** Le binaire `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` est recopié en **`src-tauri/target/debug/muse.exe`**, et c'est **cette copie** que le superviseur lance. Renommer le fichier de `binaries/` ne casse **rien** au runtime : un host démarre normalement. Il faut neutraliser **les deux**.
2. **L'exécutable de développement ne rend rien sans Vite.** Lancé seul, il charge le frontend depuis `localhost:1420` et la fenêtre affiche `ERR_CONNECTION_REFUSED` — une erreur du navigateur, pas une guidance de l'application. Le serveur Vite doit tourner pour que le test porte sur l'app.

## État cassé obtenu

| Prérequis | État |
|---|---|
| `src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe` | renommé en `.disabled` |
| `src-tauri/target/debug/muse.exe` | renommé en `.disabled` |
| `%USERPROFILE%\.config\muse\auth.json` | déplacé hors du profil |
| Processus `muse.exe` | **0** — aucun host n'a pu démarrer |

## Résultat

**L'application démarre et reste stable** avec un sidecar absent : pas de crash, la liste des conversations s'affiche normalement, **aucun panneau de récupération sur l'accueil** — conforme à la documentation (« la sonde ne s'affiche pas sur l'écran d'accueil »).

La guidance apparaît **au moment où un host doit démarrer**, c'est-à-dire après création d'une conversation et envoi. Le panneau de récupération expose alors :

| Élément observé | Valeur |
|---|---|
| Vocabulaire du diagnostic | **`sidecar`**, **`binary`**, **`triple`**, **`folder`** |
| Actions proposées | **« Try again »**, **« Choose workspace folder »** |

C'est exactement ce que M0-10 décrit : un binaire correspondant au *target triple*, la disponibilité de la dépendance, l'accessibilité du dossier, et la relance explicite — **jamais** une installation implicite.

## Restauration

Tout a été remis en place et **vérifié** :

| Élément | État après restauration |
|---|---|
| `binaries/muse-x86_64-pc-windows-msvc.exe` | présent, 396,1 Mo |
| `target/debug/muse.exe` | présent |
| `%USERPROFILE%\.config\muse\auth.json` | présent, 135 octets |
| Fichiers `.disabled` résiduels | **aucun** |
| Application relancée | **1 host démarré**, 63 conversations, aucun panneau d'erreur |

## Ce qui reste non couvert pour M0-10

- **Détection sur machine propre** : la neutralisation du sidecar simule l'absence du binaire, **pas** un premier lancement sur une machine où rien n'a jamais été installé. Registre, WSL non configuré, profil vierge : non exercés.
- **Distributions WSL non par défaut** : non exercées. WSL n'a pas été désinstallé — cela détruirait les distributions de l'utilisateur.
- **Parcours d'authentification réel** : `auth.json` a été retiré, mais je n'ai **pas** vérifié que le panneau distingue ce cas d'un binaire manquant. Le mot `authentication` n'apparaît pas dans les correspondances relevées, ce qui peut signifier que le binaire absent masque les autres causes.
- **Matrice multi-OS** : hors périmètre.

**M0-10 n'est donc pas clos**, mais sa guidance d'échec est désormais **exercée sur un cas réel**, ce qui n'avait jamais été fait.
