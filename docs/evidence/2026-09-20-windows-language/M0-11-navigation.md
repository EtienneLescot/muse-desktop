# Détails de navigation — câblage vérifié (M0-11, 20 septembre 2026)

Second volet de M0-11, après l'[audit de copie anglaise](M0-11-copie-anglaise.md) qui couvrait le premier.

## Ce que le volet « détails de navigation » recouvre

Trois éléments, tous déjà implémentés dans `src/lib/` :

| Helper | Rôle | Test de comportement existant |
|---|---|---|
| `primaryModifier()` | renvoie `Cmd` sur Apple, `Ctrl` ailleurs | `test/a11y.test.ts` |
| `zoomShortcutTitle()` | infobulle du raccourci de zoom, selon l'OS | `test/a11y.test.ts` |
| `displayPath()` | chemin natif lisible pour l'utilisateur | — |
| `userFacingError()` | copie d'erreur centralisée | `test/errorCopy.test.ts` |

## Le trou que j'ai trouvé

Les **fonctions** sont testées. Ce qui ne l'était pas, c'est que l'interface les **appelle**. Un composant pouvait coder `Ctrl` en dur dans une infobulle, ou afficher un chemin natif brut, et **tous les tests existants passaient quand même**.

Vérification du câblage réel par lecture de source — il est large :

| Surface | Appel |
|---|---|
| `App.tsx` | `primaryModifier()`, `zoomShortcutTitle()`, `displayPath(active.workspace)` |
| `SessionSidebar.tsx` | `` `${primaryModifier()}+Tab to switch conversations` `` |
| `InputPanel.tsx` | `` `Send answer (${primaryModifier()}+Enter)` `` |
| **16 composants** | `userFacingError(` pour leurs échecs |

## Le verrou ajouté

`test/navigationDetails.test.ts` — 7 tests qui échouent si un point d'appel disparaît ou si un helper est redéclaré localement (une copie locale dériverait de l'implémentation testée).

**Efficacité vérifiée, pas supposée :** en remplaçant dans `SessionSidebar.tsx` l'appel par un `Ctrl` codé en dur — exactement la régression que le test doit attraper — il **échoue** :

```
✖ ../src/components/SessionSidebar.tsx no longer calls primaryModifier()
  — the sidebar shortcut hint switches conversations and is OS-dependent
```

Après restauration : **942 tests, 942 passés, 0 échec** (contre 935 avant).

## Établi

- Les trois helpers de navigation sont **réellement câblés** dans l'interface, sur les surfaces où M0-11 les attend, et cette liaison est désormais **verrouillée par un test** qui échoue sans elle.
- La copie d'erreur des surfaces OSS passe bien par `userFacingError`, le module dont le comportement est testé ailleurs — **vérifié sur 6 composants nommés**.

## Limites — ce qui n'est pas couvert

- Le verrou est **structurel** : il prouve que l'appel existe, pas que l'infobulle **s'affiche correctement** dans la webview empaquetée. Un libellé mal rendu, tronqué ou écrasé par un style ne serait pas détecté.
- **Aucune vérification sur macOS ni Linux** : `primaryModifier()` teste `navigator.platform`, mais seul le comportement de la fonction est testé, pas son effet sur un vrai système Apple. La branche `Cmd` est prouvée par test unitaire, pas par exécution.
- **`displayPath()` n'a pas de test de comportement** : je n'ai verrouillé que son appel. Ses cas limites — chemins UNC, `\\?\`, espaces, longueur — ne sont pas exercés.
- Les **infobulles ne sont pas auditées exhaustivement** : je n'ai vérifié que les points d'appel listés. D'autres surfaces peuvent porter des raccourcis écrits en dur sans que ce test les voie.
- Le **rendu réel des infobulles** (survol, délai d'apparition, accessibilité) n'est pas mesuré.

## État de M0-11

| Volet | État |
|---|---|
| Finir l'anglais | **mesuré** sur 7 surfaces, limites déclarées |
| Détails de navigation | **câblage vérifié et verrouillé** ; rendu natif et branches OS non exercés |

**M0-11 n'est pas clos.** Ses deux volets disposent maintenant d'une vérification reproductible, mais aucun des deux n'a été validé dans la webview empaquetée sur les trois OS.
