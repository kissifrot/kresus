# Kresus — guide de développement

Application de bureau de gestion financière familiale pour les usages français, fondée sur Tauri 2, Rust, TypeScript et SQLite. L’interface et la documentation sont en français ; le code et ses commentaires sont en anglais. Les commentaires doivent expliquer succinctement les règles métier et les comportements non évidents, notamment en Rust et en TypeScript.

La [spécification et l’état fonctionnel](../SPECIFICATION.md) décrivent les fonctionnalités réalisées, les règles métier, les limites et les besoins initiaux non encore réalisés. Les captures de référence sont dans [`references/`](../references/). Le document initial « Outil de Gestion de nos Comptes.docx » a été fourni séparément et n’est pas dans le dépôt.

## Démarrage et construction

Depuis ce dossier `kresus/`, qui contient `package.json` :

```sh
nvm use
yarn install
yarn tauri dev
```

Le fichier `.nvmrc` sélectionne la version LTS de Node avec nvm. Si elle n’est pas encore installée, exécuter d’abord `nvm install`. Sans nvm, utiliser une version compatible indiquée dans `package.json` : Node 22.22.2 ou ultérieur dans la branche 22, 24.15.0 ou ultérieur dans la branche 24, ou 26 et supérieur. La version de Rust utilisée pour les tests est 1.99.1 ; `rusqlite` 0.41.1 indique Rust 1.89 au minimum.

L’installation des dépendances est nécessaire avant le premier démarrage et après leur modification. Une erreur `tauri: not found` peut indiquer que cette étape n’a pas été effectuée. La compilation du frontend et la production de l’application se lancent respectivement avec :

```sh
yarn build
yarn tauri build
```

## Tests

Depuis ce dossier :

```sh
yarn test
cargo test --manifest-path src-tauri/Cargo.toml
```

Vitest utilise un DOM simulé et des commandes Tauri simulées : les tests de `tests/` couvrent comptes et foyer, opérations et virements, catégories, échéances et rapport de dépenses. Ils ne modifient pas la base de l’utilisateur. Les comptes et opérations partagent les outils de `tests/register-fixtures.ts`.

Les tests Rust, placés près de chaque domaine, utilisent des bases SQLite isolées, en mémoire ou dans un fichier temporaire. Ils couvrent notamment les opérations, les catégories, les virements et les échéances : périodicité, années bissextiles, modifications ponctuelles et de série, enregistrement et persistance. Ces tests ne touchent pas à la base de l’utilisateur.

Pour de futurs tests des commandes Tauri ou de l’interface, voir la documentation officielle : [tests Tauri](https://v2.tauri.app/develop/tests/), [simulation des API](https://v2.tauri.app/develop/tests/mocking/) et [WebDriver](https://v2.tauri.app/develop/tests/webdriver/).

### Mesure de performance

Deux scénarios facultatifs construisent chacun 10 000 opérations fictives sur dix ans, sans toucher à la base de l’utilisateur :

```sh
yarn test:performance
cargo test --manifest-path src-tauri/Cargo.toml performance_reference_10000_operations -- --ignored --nocapture
```

Le premier mesure le registre, un filtre, le pointage et les changements de compte dans jsdom avec un backend simulé. Le second utilise une base SQLite temporaire et mesure l’insertion groupée, les soldes, la lecture complète et paginée avec totaux, leur sérialisation JSON et les suggestions de destinataires. Les mesures sont indicatives, sans seuil automatique : elles varient selon la machine et la charge. Le DOM simulé ne mesure ni le rendu de la WebView Tauri, ni le transport réel entre Rust et l’interface ; il faudra compléter par un test de bout en bout avant de conclure sur la fluidité de l’application. L’insertion mesurée n’est pas un import Money, qui reste à développer.

### Générer une base de test

Le script crée une base Kresus distincte avec 12 000 opérations fictives réparties sur dix ans, dont 10 000 sur le compte courant. Il nécessite Python 3 et sa bibliothèque SQLite intégrée :

```sh
python3 scripts/generate_test_database.py
```

Le fichier est créé dans `donnees-test/kresus-test-12000.sqlite3` et peut être ouvert depuis la barre latérale de Kresus. Pour choisir un autre emplacement ou volume :

```sh
python3 scripts/generate_test_database.py --output donnees-test/autre-test.sqlite3 --operations 60000
```

Le script refuse d’écraser un fichier existant et utilise le schéma SQLite de l’application. Les données sont reproductibles et fictives. Git ignore les bases SQLite et leurs fichiers auxiliaires ; les fichiers déjà suivis ou ajoutés à l’index doivent toutefois être retirés de l’index séparément.

## Données et sauvegarde

La base SQLite `kresus.sqlite3` est créée dans le répertoire de données de l’application fourni par Tauri. Sous Linux, il s’agit généralement de `~/.local/share/com.kissifrot.kresus/`. Copier ce fichier lorsque l’application est arrêtée permet de le sauvegarder. Le bouton « Ouvrir une base… » permet de sélectionner une autre base SQLite compatible Kresus, ouverte en lecture-écriture directement à son emplacement. Le nom du fichier actif apparaît dans la barre latérale ; « Revenir à la base habituelle » rétablit la base du répertoire utilisateur. Le choix ne persiste pas après redémarrage. Les fichiers SQLite arbitraires ou sans compte sont refusés ; aucun import Money ni génération de base volumineuse n’est effectué par cette commande. Les montants sont stockés, échangés entre Rust et TypeScript et calculés en centimes entiers ; les euros sont utilisés à la saisie et à l’affichage.

Les données d’exemple sont insérées uniquement à la création d’une nouvelle base. Une donnée d’exemple supprimée ne réapparaît pas au redémarrage, y compris pour les bases créées par une version précédente. L’initialisation peut également migrer les anciennes opérations utilisateur enregistrées dans le stockage local du prototype. Les détails et autres limites sont décrits dans la spécification.

## Organisation

Dans `src-tauri/src/`, `lib.rs` initialise Tauri et enregistre les commandes ; `database.rs` gère la connexion et le schéma SQLite ; `database_tests.rs` vérifie son initialisation et la conservation des suppressions. `accounts.rs`, `transactions.rs`, `schedules.rs` et `categories.rs` regroupent commandes et logique métier. Les tests propres à chaque domaine se trouvent dans les fichiers suffixés `_tests.rs` ; `test_support.rs` fournit les éléments communs.

Dans `src/`, `main.ts` charge les données au démarrage. `accounts.ts`, `household.ts`, `transactions.ts`, `transfers.ts`, `schedules.ts`, `categories.ts` et `spending-report.ts` regroupent les vues et interactions par domaine ; `payees.ts` partage les suggestions de destinataires. `state.ts`, `types.ts` et `format.ts` contiennent l’état partagé, les types et les fonctions communes de présentation. `styles.css` contient les styles communs de l’interface.
