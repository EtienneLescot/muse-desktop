# Nettoyage des conversations de test — méthode et pièges (20 septembre 2026)

Cette campagne a créé des dizaines de conversations de test dans l'application. Les supprimer a demandé **quatre tentatives**, dont trois ont échoué pour des raisons différentes. Ce document conserve ce qui marche et pourquoi le reste ne marchait pas.

## Résultat

| Mesure | Avant | Après |
|---|---|---|
| Conversations dans la barre latérale | **41** | **1** |
| Compteur affiché | 10 (après résurrections) | **1** |
| Clés de journal | 13 | **1** |

Il reste exactement la conversation réelle de l'utilisateur : *« Explain the project structure and its main… »*, 15 entrées, intacte à chaque étape.

**La suppression survit à un rechargement de page** — c'est le contrôle qui distingue la bonne méthode des mauvaises.

## Les trois échecs, et ce qu'ils ont appris

### 1. Réécrire `localStorage` app ouvert : l'application réécrit par-dessus

Première passe : 41 → 6 sessions, 15 clés de journal supprimées. **Sembe concluant.**

Puis l'application a **réécrit sa propre copie** — elle gardait la liste en mémoire — et 5 conversations supprimées sont **revenues en coquilles vides**, avec le titre générique `Session <id>` et zéro entrée.

**Leçon :** pour un objet géré par l'application, modifier son stockage pendant qu'elle tourne ne tient pas.

### 2. Réécrire `localStorage` app fermée : le côté natif réintroduit

Deuxième passe, application arrêtée : 10 → 1. **Stable sur 12 secondes**, vérifié par sondage.

Puis un **rechargement de page** a fait revenir **les mêmes 9 sessions**, avec les mêmes identifiants. Elles ne venaient donc pas de `localStorage` mais d'un **registre côté natif** (Tauri). Recherche sur disque (`.config\muse`, `.muse`, `%LOCALAPPDATA%\muse`, `%APPDATA%\muse`) : **aucune trace** des identifiants.

**Leçon :** supprimer du stockage web ne tue pas la session. L'infobulle du bouton le dit pourtant explicitement : *« Kill session and delete its local history »*.

### 3. Piloter le bouton par CDP : trois obstacles en un

- Le bouton **« Delete… »** n'est pas dans la barre latérale : il vit dans une **boîte de dialogue modale** ouverte par un bouton **`aria-label="Actions for …"`** (`dialog.current?.showModal()`). Une version antérieure cherchait un menu contextuel et un double-clic, qui n'existent pas.
- Une évaluation de page **asynchrone** revenait avec un objet vide — limitation CDP déjà rencontrée sur le test de course de file.
- Un appel `Runtime.evaluate` **sans `returnByValue`** renvoie une référence d'objet distant : l'appelant lit `undefined` et ne peut pas le distinguer d'un échec.

**Leçon :** le bon chemin est `Actions for …` → `Delete…` → `Delete conversation`, en **appels synchrones séparés**.

## La méthode qui marche

```powershell
# Essai à blanc : prouve le chemin en supprimant UNE ligne
node scripts/cdp-delete-conversations.mjs

# Supprime toutes les coquilles restantes
node scripts/cdp-delete-conversations.mjs --apply
```

**Règle de sécurité :** seules les lignes dont le libellé est `Actions for New conversation` ou `Actions for Session <id>` sont touchées. Une session qui a produit un vrai tour porte un **titre descriptif** et n'est jamais sélectionnée — vérifié à chaque étape, le titre réel apparaît intact dans tous les relevés.

**Garde-fou :** si le nombre de coquilles ne diminue pas après une suppression, le script **s'arrête** au lieu de continuer à l'aveugle.

## Sauvegarde

`%USERPROFILE%\muse-localstorage-backup-2026-09-20.json` — 215 Ko, 61 clés, l'état complet **d'avant** toute suppression. Elle contient les conversations supprimées et permet un retour arrière.

## Ce que ce nettoyage a révélé sur le produit

- **Une conversation sans tour abouti garde un titre générique** et se présente comme « New conversation » dans la barre latérale, tandis que son titre stocké est `Session <id>`. C'est ce qui rend la distinction fiable… et c'est aussi une incohérence d'affichage entre le stockage et l'interface.
- **Les sessions sont réintroduites par le côté natif au rechargement** alors qu'elles n'existent plus dans le stockage web. Après une suppression par `localStorage`, l'application et son registre natif divergent silencieusement — l'interface a continué d'afficher 10 entrées pour un stockage à 1.
- **L'observabilité est faible** : la conversation est supprimée, mais rien dans l'interface ne indique qu'une session native lui survit.

Ces trois points ne sont pas des défauts du ticket en cours, mais ils mériteraient une entrée dans la roadmap si le sujet revient.
