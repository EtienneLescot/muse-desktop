# Cycle complet de distribution Windows — M4-09 (20 septembre 2026)

Installer, vérifier, désinstaller, et prouver que les projets survivent. C'est le critère de sortie de M4-09 qui n'avait jamais été exécuté.
Test **volontairement destructif sur la machine de l'utilisateur**, avec son autorisation explicite ; état final vérifié et restauré.

## Artefact utilisé

`src-tauri/target/release/bundle/nsis/Muse-Desktop_0.1.0_x64-setup.exe` — **75 617 763 octets** (72,11 Mio), SHA-256 `c8fcb5da1c2f49c3527e83e9f4791c068811a2fc8e45d67c439294221a6c30bd`, construit au round 13 (`docs/evidence/2026-09-20-windows-release/M4-09.md`).

## Ligne de base à préserver

Relevée par CDP sur le profil réel : **64 conversations**, **2 projets** (`openscreen`, `muse-desktop`), **13 journaux**, **61 clés** `localStorage`.

## 1. Installation

```powershell
Start-Process -FilePath "…\Muse-Desktop_0.1.0_x64-setup.exe" -ArgumentList "/S" -Wait
```

| Mesure | Résultat |
|---|---|
| Code de sortie | **0** |
| Répertoire d'installation | **`%LOCALAPPDATA%\Muse-Desktop`** — *pas* `Programs\`, contrairement à ce que j'attendais |
| Contenu | `muse-desktop.exe` (20,05 Mo), **`muse.exe` (396,14 Mo)** — le sidecar est bien embarqué —, `uninstall.exe` (0,08 Mo) |
| Entrée de désinstallation | `HKCU\…\Uninstall` → `DisplayName: Muse-Desktop`, `DisplayVersion: 0.1.0`, `UninstallString: …\uninstall.exe` |
| Privilèges | aucun — installation en `currentUser`, cohérent avec `installMode: currentUser` de `tauri.conf.json` |

**L'application installée démarre** : `Muse-Desktop.exe` vivant, fenêtre « Muse-Desktop », `Responding: True`. Aucun sidecar n'est lancé **au démarrage** — cohérent avec le comportement documenté (un host par workspace, créé à la demande).

## 2. Désinstallation

```powershell
Start-Process -FilePath "…\Muse-Desktop\uninstall.exe" -ArgumentList "/S" -Wait
```

| Mesure | Résultat |
|---|---|
| Code de sortie | **0** |
| Répertoire d'installation | **supprimé** |
| Entrée de désinstallation | **retirée** (0 entrée `*Muse*` restante) |

## 3. Les projets survivent-ils ? — oui, à l'identique

Relecture du `localStorage` après désinstallation, par le même chemin de lecture qu'avant :

| Mesure | Ligne de base | Après désinstallation |
|---|---|---|
| Conversations | 64 | **64** |
| Projets | `openscreen`, `muse-desktop` | **`openscreen`, `muse-desktop`** |
| Journaux | 13 | **13** |
| Clés totales | 61 | **61** |

**Établi :** la désinstallation retire le programme et son entrée de registre **sans toucher aux données utilisateur**. Le critère « désinstaller sans effacer les projets » est satisfait, mesuré sur un profil réel à 64 conversations.

### Un détail de méthode

Une première empreinte SHA-256 du dossier `leveldb` (nom + taille + horodatage de chaque fichier) **différait** avant/après : `F9C7813A…` → `8FECBA47…`. Ce n'était **pas** une perte de données : l'application installée avait tourné une douzaine de secondes et écrit dans ce stockage, ce qui modifie horodatages et taille (388,9 → 391,6 Ko, **9 fichiers dans les deux cas**). L'empreinte n'était donc pas un bon indicateur ici ; la **relecture du contenu** l'est, et elle est identique. Je le consigne parce que la conclusion « données modifiées » aurait été fausse.

### Emplacement des données

`%LOCALAPPDATA%\com.muse.desktop\EBWebView\` — l'identifiant du produit (`com.muse.desktop`). **L'application installée et la version de développement partagent ce dossier**, ce qui est précisément ce qui a permis de comparer avant/après avec le même chemin de lecture.

## Ce qui reste ouvert pour M4-09

- **Mise à jour depuis une version précédente** : le critère comporte « mettre à jour depuis version précédente ». Je n'ai pas construit de version antérieure, donc **la chaîne de mise à jour n'a pas été exercée sur une installation réelle** — seulement testée en local via `release:update` (round 13) et la chaîne delta.
- **Machine propre** : la machine avait déjà WSL, Muse et un profil à 64 conversations. Ce n'est **pas** un premier lancement sur machine vierge.
- **MSI** : seul le NSIS a été installé et désinstallé.
- **Signature** : l'installateur reste `NotSigned` (relevé au round 13), donc un avertissement SmartScreen est attendu sur une machine tierce.
- **macOS / Linux** : aucun bundle construit pour ces cibles.
- **Désinstallation et données d'autres profils** : non vérifié.

**M4-09 n'est pas clos** sur la mise à jour réelle et la machine propre, mais son critère principal — installer, fonctionner, désinstaller **sans perdre les projets** — est désormais **exécuté et mesuré**, ce qui n'avait jamais été fait.

## État final de la machine

| Élément | État |
|---|---|
| Programme installé | **désinstallé** (répertoire et registre) |
| Données applicatives | **intactes** — 64 conversations, 2 projets |
| `%USERPROFILE%\.config\muse\auth.json` | présent |
| WSL | distributions intactes |
| Application | relancée en version de développement, fonctionnelle |
