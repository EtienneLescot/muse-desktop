# Build Windows avec moteur WSL

Cette variante produit une interface Tauri native Windows x64. Le moteur
reste Muse Code dans la distribution WSL par défaut, installé et authentifié
via `~/.local/bin/muse`. Aucune information d'authentification n'est embarquée.

Depuis la racine du dépôt, sous PowerShell :

```powershell
cargo build --manifest-path scripts/wsl-bridge/Cargo.toml --release
Copy-Item scripts/wsl-bridge/target/release/muse-wsl-bridge.exe src-tauri/binaries/muse-x86_64-pc-windows-msvc.exe -Force
npm run tauri -- build --bundles nsis
```

L'installateur se trouve dans `src-tauri/target/release/bundle/nsis/`.
Il n'installe pas WSL ni Muse. Cette variante est destinée à une machine déjà
configurée ; ce n'est pas une distribution autonome du moteur Windows.

Le pont conserve le flux JSON-RPC, traduit le dossier de `session/start`
vers le chemin WSL et ferme l'entrée du moteur quand le superviseur se
déconnecte. Les chemins de sortie des outils restent des chemins Linux.
Les projets Windows doivent être accessibles à la distribution WSL.

Validation locale : `initialize`, `initialized`, `session/start` avec un
dossier Windows ; fermeture propre sur EOF. Aucun tour modèle facturé
n'est nécessaire à ce test de connexion. Les intégrations avancées entre
chemins Windows et Linux restent à tester séparément.
