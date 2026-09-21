# Périmètre de la beta 0.1.0 — Windows

**Objectif :** une beta **convergente**. On ne livre pas ce qui est prêt, on livre ce qui est **nécessaire**, et tout le reste est explicitement dehors.

Un périmètre se définit par ses exclusions. Ce document liste donc **ce qui est dedans**, mesuré, et **ce qui est dehors**, avec la raison.

## Le critère d'entrée : le parcours minimum, vérifié

`scripts/beta-smoke.mjs`, exécuté sur la version de développement :

| Étape | Résultat |
|---|---|
| Créer une conversation | **OK** |
| Composer utilisable | **OK** |
| Envoi accepté (composer vidé) | **OK** |
| Tour en cours | **OK** |
| **Réponse du modèle reçue** | **OK** |
| Tour terminé | **OK** |
| Aucune erreur affichée | **OK** |

Et la persistance, après **arrêt complet de l'application et des hosts**, puis relance :

| Mesure | Résultat |
|---|---|
| Conversations stockées | **2** — conservées |
| Conversation active | conservée |
| Projets | `openscreen`, `muse-desktop` — conservés |
| **Réponse du modèle dans le journal** | **conservée** (2 entrées avec le marqueur) |
| Compteur affiché | **2** |

**Le parcours qu'un utilisateur fera en premier fonctionne, et son travail survit à un redémarrage.**

## Dans la beta

| # | Élément | Statut |
|---|---|---|
| 1 | Lancer l'application, créer une conversation, envoyer un message, recevoir une réponse | **vérifié** |
| 2 | Retrouver ses conversations et ses projets après un redémarrage | **vérifié** |
| 3 | Installer, mettre à jour et désinstaller **sans perdre ses projets** | **vérifié** (`M4-09`) |
| 4 | Webview sécurisée (contexte isolé, pas de Node exposé) | vérifié |
| 5 | Interface en anglais, navigation au clavier fonctionnelle | vérifié (`M0-11`, `M0-12`) |
| 6 | Transcript utilisable sur un long historique (fenêtre bornée, finder) | vérifié (`M1-13`) |
| 7 | Installateur NSIS Windows x64 | construit, `NotSigned` |
| 8 | Notes de version 0.1.0 | à écrire |

## Exclu de la beta, avec la raison

| Élément | Pourquoi c'est dehors |
|---|---|
| **Signature Authenticode** | demande un certificat et une décision d'achat. L'installateur affichera un avertissement SmartScreen. **Documenté dans les notes de version**, pas caché. |
| **Mise à jour automatique en ligne** | demande un hébergement qui n'existe pas. La **mise à jour par installateur** est vérifiée et suffit pour une beta. |
| **macOS et Linux** | aucun bundle construit, aucune preuve. Hors sujet pour une beta Windows. |
| **Qualification par lecteur d'écran** | je ne peux pas piloter un lecteur d'écran. Le balisage est vérifié (`M0-12`), l'annonce réelle ne l'est pas. |
| **Le site du navigateur intégré** (recadrage de région, capture visuelle) | la navigation et les annotations fonctionnent ; les deux fonctions manquantes ne bloquent pas le parcours principal. |
| **Les quatre chantiers client** du plan du 20/09 | aucun défaut n'a été **reproduit**. Les écrire maintenant serait deviner — l'erreur que cette campagne a corrigée sept fois. Ils restent planifiés, pas dans la beta. |
| **Sortie des commandes `userShell` dans l'interface** | le repli existe (insérer la sortie dans le prompt). Le host fournit l'item, le client ne l'affiche pas — gênant, pas bloquant. |
| **Confirmation visuelle du modèle et de l'effort** | le client affiche le modèle demandé, marqué comme non live. Honnête, imparfait, non bloquant. |
| **`M0-01`, `M0-14`, `M1-10` — critères non couverts** | ce sont des critères de robustesse sur des cas limites. Une beta n'a pas à les couvrir tous, et les documents de preuves disent lesquels. |

## Ce qui doit encore être fait pour livrer

1. **Vérifier le paquet installé** — lancer l'application **installée** (pas la version de développement) et refaire le parcours minimum sur le paquet NSIS. C'est la différence entre « ça marche chez moi en dev » et « ça marche pour un utilisateur ».
2. **Notes de version** — ce qui marche, ce qui ne marche pas, l'avertissement SmartScreen, la configuration requise (Muse Code installé).
3. **Tag et version** — `v0.1.0-beta.1`, cohérent entre `package.json`, `tauri.conf.json` et le nom de l'installateur.
4. **Nettoyer les conversations de test** avant livraison, pour que l'application ne s'ouvre pas sur des résidus.

## Ce qui **n'est pas** un critère de sortie

- Aucun ticket du groupe 1 n'a besoin d'être **clos**. La beta se juge sur le parcours utilisateur, pas sur une matrice.
- Aucune preuve macOS ou Linux.
- Aucune revue CodeRabbit : elle a été rate-limited pendant toute la campagne, et je n'en fais pas une dépendance.

## Le risque principal, et il est assumé

**L'application n'est pas signée.** Windows affichera un avertissement SmartScreen au premier lancement. C'est le propre d'une beta, mais cela doit être **écrit dans les notes de version** — un utilisateur qui découvre l'avertissement sans explication conclura à un logiciel douteux.

## Ce que la beta ne prétend pas être

- Ce n'est pas une version stable : la reprise après plantage d'un host n'est pas garantie dans tous les cas.
- Ce n'est pas une version complète : plusieurs fonctions de l'interface existent sans être qualifiées.
- Ce n'est pas une version signée.

**Une beta sert à recueillir des retours sur un parcours réel.** Ce périmètre est choisi pour que ce parcours soit solide, et pour que le reste soit **dit** plutôt que découvert.
