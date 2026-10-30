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

Vitest utilise un DOM simulé et des commandes Tauri simulées : les tests de `tests/` couvrent comptes et foyer, opérations et commentaires, virements, catégories, échéances, conversions monétaires et rapport de dépenses. Ils ne modifient pas la base de l’utilisateur. Les comptes et opérations partagent les outils de `tests/register-fixtures.ts`.

Les tests Rust, placés près de chaque domaine, utilisent des bases SQLite isolées, en mémoire ou dans un fichier temporaire. Ils couvrent notamment les opérations, les catégories, les virements et les échéances : périodicité, années bissextiles, modifications ponctuelles et de série, enregistrement et persistance. Ces tests ne touchent pas à la base de l’utilisateur.

Pour de futurs tests des commandes Tauri ou de l’interface, voir la documentation officielle : [tests Tauri](https://v2.tauri.app/develop/tests/), [simulation des API](https://v2.tauri.app/develop/tests/mocking/) et [WebDriver](https://v2.tauri.app/develop/tests/webdriver/).

### Sauvegarde et restauration

Dans la barre latérale, « Sauvegarder… » crée un nouveau fichier SQLite à l’emplacement choisi, sans interrompre l’application. Choisir un nom qui n’existe pas encore : la sauvegarde ne remplace aucun fichier. La copie est réalisée par SQLite et inclut les écritures présentes dans le journal WAL.

« Restaurer… » permet de sélectionner une sauvegarde, puis demande confirmation avant de remplacer la **base actuellement ouverte**. Le fichier sélectionné est vérifié et reste intact. Une base temporairement ouverte est restaurée elle aussi dans son fichier ; au redémarrage, l’application ouvre de nouveau la base habituelle.

### Formatage du code

Depuis le répertoire `kresus`, `yarn format` applique Prettier aux fichiers TypeScript, CSS et HTML et `rustfmt` aux sources Rust. `yarn format:check` vérifie les mêmes fichiers sans les modifier. Les deux formateurs utilisent une largeur cible de 100 caractères ; les requêtes SQL et certains blocs HTML inclus dans des chaînes peuvent nécessiter une mise en forme manuelle.

### Parcours Tauri avec WebDriver sous Linux

Le parcours `e2e/tauri-smoke.mjs` lance la vraie application dans sa WebView, avec une base fictive temporaire de 12 000 opérations. Il vérifie la navigation, la pagination et le filtre « À pointer », puis la création d’un compte, la gestion d’une opération avec commentaire et son pointage, la création, la modification et la suppression d’un virement, la gestion des catégories, ainsi que la création, la modification ponctuelle et de série, la modification d’une occurrence future, l’enregistrement et la suppression d’une échéance. Il contrôle aussi la recherche, les limites par nombre et par date, les retards depuis le foyer, un virement récurrent et les totaux du rapport de dépenses avec exclusion des virements. Lorsque le fichier fictif `references/Money.mny` est disponible, il vérifie également l’aperçu Money, la création d’une nouvelle base et son contenu SQLite (compte, catégories, opérations, échéances, solde et enregistrement d’un virement récurrent). On peut spécifier son emplacement avec `KRESUS_MONEY_SAMPLE` ; ce test attend les valeurs du fichier de référence (comptes de 1 000 € et 2 000 €, opérations de −100 € et −25 €, 138 catégories). Sans ce fichier, il est signalé comme ignoré. Les confirmations sont acceptées automatiquement dans cette base temporaire. Les durées affichées incluent les échanges WebDriver ; ce parcours ne couvre pas encore tous les scénarios du document initial et ne remplace pas une inspection visuelle manuelle.

Il nécessite `tauri-driver`, le pilote WebKitGTK et, pour un affichage virtuel, `xvfb-run`. Sur Ubuntu 26.04, les paquets système correspondants sont `webkitgtk-webdriver` et `xvfb` ; le pilote Tauri s’installe avec `cargo install tauri-driver --locked`. Les noms des paquets peuvent varier selon la distribution. Après installation :

```sh
nvm use
yarn tauri build --debug --no-bundle --features e2e
xvfb-run -a yarn test:e2e
```

Le test d’un collage réel est facultatif : il nécessite `xclip` et un affichage X11 isolé pour éviter de modifier le presse-papiers de la session utilisateur. Par exemple :

```sh
GDK_BACKEND=x11 KRESUS_E2E_CLIPBOARD=1 xvfb-run -a yarn test:e2e
```

Sans cette option, le parcours signale que le test du presse-papiers est ignoré ; les formats de montants sont aussi couverts par les tests TypeScript.

Le test crée son propre répertoire de données temporaire et ne charge pas la base habituelle. La fonctionnalité de compilation `e2e`, active uniquement en mode debug, remplace les boîtes de dialogue natives de l’import et de la sauvegarde/restauration par les chemins du fichier de référence et de la nouvelle base temporaire : la WebView, les commandes Tauri, le lecteur et SQLite sont réels, mais les sélecteurs réels sont vérifiés séparément par le parcours natif décrit ci-dessous. Sans cette fonctionnalité, le test Money attendrait les boîtes de dialogue natives. Les ports sont choisis localement pour la durée du test. Un exécutable `tauri-driver` situé ailleurs peut être fourni avec la variable `TAURI_DRIVER`.

### Dialogues natifs et inspection visuelle sous Linux

Le parcours complémentaire utilise les vrais sélecteurs GTK : il vérifie leur ouverture et leur annulation au clavier, puis crée une sauvegarde, l’ouvre et revient à la base habituelle. Il utilise une base temporaire et retire les chemins substitués par la compilation `e2e`. Sous Linux avec WebKitGTK, `xdotool`, Xvfb, D-Bus et le sélecteur GTK disponibles :

```sh
GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=GNOME xvfb-run -a dbus-run-session -- yarn test:e2e:native
```

La session X11 et le bus D-Bus doivent être isolés : le script pilote les fenêtres au clavier. Le test cible les titres des sélecteurs GTK observés dans cet environnement ; d’autres portails ou bureaux peuvent présenter des variantes. Il vérifie également la sélection native du fichier Money fictif, son aperçu et l’annulation de l’import lorsque ce fichier est disponible. Il ne valide pas la confirmation de restauration ni la sélection native de la destination d’un import Money. La suite WebDriver standard vérifie aussi les parcours clavier de plusieurs formulaires, le registre et l’éditeur, ainsi que leur affichage et celui du formulaire d’échéance à 900 × 620, 1 100 × 700 et 1 280 × 820 pixels. Pour conserver des captures à inspecter, définir `KRESUS_E2E_SCREENSHOTS` avec un répertoire de destination avant le lancement.

### Mesure de performance

Deux scénarios facultatifs construisent chacun 10 000 opérations fictives sur dix ans, sans toucher à la base de l’utilisateur :

```sh
yarn test:performance
cargo test --manifest-path src-tauri/Cargo.toml performance_reference_10000_operations -- --ignored --nocapture
```

Le premier mesure le registre, un filtre, le pointage et les changements de compte dans jsdom avec un backend simulé. Le second utilise une base SQLite temporaire et mesure l’insertion groupée, les soldes, la lecture complète et paginée avec totaux, leur sérialisation JSON et les suggestions de destinataires. Les mesures sont indicatives, sans seuil automatique : elles varient selon la machine et la charge. Le DOM simulé ne mesure ni le rendu de la WebView Tauri, ni le transport réel entre Rust et l’interface ; le parcours WebDriver ci-dessus les exerce séparément, avec les délais propres à l’automatisation. L’insertion mesurée n’est pas un import Money, qui reste à développer.

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

Dans `src-tauri/src/`, `lib.rs` initialise Tauri et enregistre les commandes ; `database.rs` gère la connexion et l’initialisation SQLite et utilise `schema.sql`, partagé avec le générateur de données fictives. `database_tests.rs` vérifie notamment l’initialisation et la conservation des suppressions. `accounts.rs`, `transactions.rs`, `schedules.rs` et `categories.rs` regroupent commandes et logique métier. Les tests propres à chaque domaine se trouvent dans les fichiers suffixés `_tests.rs` ; `test_support.rs` fournit les éléments communs.

Dans `src/`, `main.ts` charge les données au démarrage. `accounts.ts`, `household.ts`, `transactions.ts`, `transfers.ts`, `schedules.ts`, `categories.ts` et `spending-report.ts` regroupent les vues et interactions par domaine ; `payees.ts` partage les suggestions de destinataires. `state.ts`, `types.ts` et `format.ts` contiennent l’état partagé, les types et les fonctions communes de présentation. `styles.css` contient les styles communs de l’interface.

## Import expérimental Microsoft Money

Dans la barre latérale, choisir « Importer Money… », sélectionner le fichier `.mny`, vérifier l’aperçu et choisir le type de chaque compte. L’import crée une **nouvelle** base SQLite à l'emplacement choisi, sans écraser de fichier existant, puis l'ouvre jusqu'au prochain redémarrage. La lecture est locale et ne nécessite pas Java. Les fichiers de plus de 16 Mo ne sont pas encore acceptés.

L’import des fichiers Money protégés par mot de passe est hors périmètre du projet. Cette première version lit les fichiers MSISAM Jet 4 récents sans mot de passe, les comptes bancaires ouverts en euros, leurs opérations ordinaires et les catégories. Elle exclut les placements et refuse les fichiers contenant des virements enregistrés, des ventilations ou des opérations et catégories non représentables. Les échéances mensuelles ou bimestrielles sans limite reconnues, y compris les virements récurrents, sont importées ; les autres sont signalées. Les deux comptes doivent être sélectionnés pour importer un virement récurrent. La méthode de paiement par chèque est reconnue pour la signature vérifiée sur le fichier de référence ; les autres méthodes sont signalées dans l’aperçu et restent non précisées. Les notes des échéances ne sont pas reprises. Les références Money sont conservées dans les commentaires, sans interprétation comme numéros de chèque ; les statuts Money pointé et rapproché sont regroupés. Certaines variantes Money ne sont pas encore prises en charge. L'aperçu affiche au plus 100 opérations ; l'import ne se limite pas à ces 100 lignes. La compatibilité Windows reste à valider sur une installation Windows.
