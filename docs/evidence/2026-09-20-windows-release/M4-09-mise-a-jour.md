# Mise à jour depuis une version antérieure — M4-09 (20 septembre 2026)

Complète `M4-09-cycle-installation.md` : le critère « mettre à jour depuis une version précédente » n'avait **aucune preuve**, faute de version antérieure à installer. Une version `0.0.9` a donc été construite pour l'exercer.

Test **destructif sur la machine de l'utilisateur**, avec son autorisation explicite. État final restauré et vérifié.

## Un préalable vérifié

L'installeur NSIS **accepte de s'installer par-dessus une installation existante** : deux exécutions successives du même `.exe` sortent en code **0** et laissent l'application en place. Sans cela, un test de version montante aurait été impossible sans désinstallation manuelle — ce qui n'aurait plus été une mise à jour.

## Construction de la version antérieure

`0.0.9` a été produite en abaissant `version` dans `package.json` **et** `src-tauri/tauri.conf.json`, puis `npm run tauri -- build --bundles nsis`.

**Piège rencontré, et c'est une erreur de ma part :** `Set-Content -Encoding UTF8` en **Windows PowerShell 5.1 écrit un BOM**. Le `package.json` ainsi réécrit a fait échouer le build avec

```
[vite:css] Failed to load PostCSS config: [SyntaxError] Unexpected token '', " { "nam"... is not valid JSON
```

Le BOM a été retiré via Node (qui n'en ajoute pas), et le JSON validé par `JSON.parse` avant de relancer. C'est le **même piège que celui rencontré avec les shebangs** en écrivant les scripts de campagne : PowerShell 5.1 et l'encodage UTF-8 ne font pas bon ménage.

| Artefact produit | Taille |
|---|---|
| `Muse-Desktop_0.0.9_x64-setup.exe` | 75,70 Mo |
| `Muse-Desktop_0.1.0_x64-setup.exe` | 75,62 Mo |

## Protocole et résultats

Point de départ : aucune installation présente (désinstallée au préalable).

### 1. Installation de la version antérieure

| Mesure | Résultat |
|---|---|
| Code de sortie | **0** |
| `FileVersion` / `ProductVersion` | **0.0.9** / 0.0.9 |
| `DisplayVersion` au registre | **0.0.9** |
| L'application démarre | **oui** — vivante, `Responding: True` |

### 2. Mise à jour vers 0.1.0 par-dessus 0.0.9

| Mesure | Avant | Après |
|---|---|---|
| Code de sortie | — | **0** |
| `FileVersion` / `ProductVersion` | 0.0.9 | **0.1.0** / 0.1.0 |
| `DisplayVersion` au registre | 0.0.9 | **0.1.0** |
| L'application démarre | oui | **oui** — vivante, `Responding: True` |

### 3. Les projets survivent-ils à la mise à jour ? — oui, à l'identique

| Mesure | Ligne de base | Après 0.0.9 → 0.1.0 |
|---|---|---|
| Conversations | 64 | **64** |
| Projets | `openscreen`, `muse-desktop` | **`openscreen`, `muse-desktop`** |
| Journaux | 13 | **13** |
| Clés totales | 61 | **61** |

**Établi :** une mise à jour de version montante s'installe, met à jour le binaire **et** l'entrée de registre, laisse l'application fonctionnelle, et **ne touche pas aux données utilisateur**. C'est le critère de M4-09 qui manquait.

## Restauration finale

| Élément | État |
|---|---|
| Application installée | **désinstallée** — répertoire absent, **0 entrée** de registre |
| Données applicatives | **intactes** — 64 conversations, 2 projets |
| `package.json` / `tauri.conf.json` | **revenus à `0.1.0`** (restauration git, `git status` propre) |
| Installeur `0.0.9` | conservé dans `src-tauri/target/release/bundle/nsis/` — **artefact non versionné**, couvert par `src-tauri/target/` dans `.gitignore` |

## Ce qui reste ouvert pour M4-09

- **Machine propre** : la machine a déjà WSL, Muse et un profil à 64 conversations. Ce n'est pas un premier lancement sur machine vierge.
- **Signature** : les deux installeurs sont `NotSigned`, donc un avertissement SmartScreen est attendu sur une machine tierce. La signature Ed25519 optionnelle du manifeste n'a pas non plus été exercée ici.
- **MSI** : seul le NSIS a été installé, mis à jour et désinstallé.
- **Bascule de canal** (`release:orchestrate sync`) : testée en local au round 13, jamais exercée contre un hébergement réel — qui n'existe pas encore.
- **Retour arrière** : `release:update rollback` n'a pas été exercé sur une installation réelle.
- **macOS / Linux** : aucun bundle construit pour ces cibles.

**M4-09 n'est pas clos** sur la machine propre et la signature, mais ses deux critères fonctionnels — installation/désinstallation sans perte, et mise à jour de version montante sans perte — sont désormais **exécutés et mesurés**.
