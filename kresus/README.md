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

### Menus

Le menu natif « Fichier » donne accès à l’ouverture d’une base, au retour à la base habituelle, à l’import Money, à la sauvegarde, à la restauration et à la fermeture de l’application. Les raccourcis Ctrl+O et Ctrl+Maj+S ouvrent respectivement une base et le dialogue de sauvegarde. Le menu « Aide → À propos de Kresus » présente l’icône et la version installée. La base active reste indiquée dans la barre latérale.

### Sauvegarde et restauration

Dans le menu « Fichier », « Sauvegarder… » crée un nouveau fichier SQLite à l’emplacement choisi, sans interrompre l’application. Choisir un nom qui n’existe pas encore : la sauvegarde ne remplace aucun fichier. La copie est réalisée par SQLite et inclut les écritures présentes dans le journal WAL.

« Restaurer… » permet de sélectionner une sauvegarde, puis demande confirmation avant de remplacer la **base actuellement ouverte**. Le fichier sélectionné est vérifié et reste intact. Une base temporairement ouverte est restaurée elle aussi dans son fichier ; au redémarrage, l’application ouvre de nouveau la base habituelle.

### Icône de l’application

La source vectorielle est [`assets/kresus-icon.svg`](assets/kresus-icon.svg). Après toute modification, générer les icônes de bureau à partir du SVG avec :

```sh
yarn icons
```

Cette commande utilise le générateur d’icônes de Tauri et met à jour les formats PNG, ICO, ICNS et les variantes Windows dans `src-tauri/icons`. Elle nécessite les dépendances du projet. Le SVG sert aussi directement à la marque affichée dans la barre latérale ; la fenêtre « À propos » utilise le PNG généré. Les formats mobiles produits temporairement par Tauri ne sont pas conservés dans le projet.

### Vérifications GitHub Actions

Le workflow [`ci.yml`](../.github/workflows/ci.yml) lance sur Linux et Windows les tests TypeScript, Rust et du générateur de base, puis construit les paquets Tauri en mode release : un paquet `.deb` pour les distributions Linux compatibles Debian et deux installateurs Windows x64 (`.msi` et `-setup.exe` NSIS). Le formatage est vérifié sous Linux. La CI contrôle la déclaration `.kresus` dans la configuration sur les deux systèmes et vérifie aussi le lanceur et le type MIME inclus dans le paquet Debian construit. Les dépendances Rust compilées sont mises en cache séparément selon l’environnement et la version de la toolchain. Le workflow se déclenche sur les pushs et les pull requests et peut aussi être lancé manuellement depuis l’onglet Actions de GitHub. Les fichiers sont téléchargeables comme artefacts de l’exécution pendant sept jours ; aucune version GitHub Release n’est publiée automatiquement.

Les installateurs sont des builds de test non signés. Ils ne remplacent pas une validation sur les systèmes visés ; ils peuvent nécessiter une confirmation du système à l’installation. Le paquet Debian est construit sur Ubuntu 26.04, afin de stabiliser sa base de compatibilité ; une distribution plus ancienne peut ne pas fournir les versions nécessaires de ses bibliothèques. Tauri recommande de construire sur le système le plus ancien que l’on souhaite prendre en charge : voir sa [documentation Debian](https://v2.tauri.app/distribute/debian/). Le runner Ubuntu 22.04 étant en cours de retrait, une éventuelle cible plus ancienne nécessitera une autre solution de compilation. Les formats Linux universels et d’autres architectures restent à étudier. La [documentation Tauri pour Windows](https://v2.tauri.app/distribute/windows-installer/) précise notamment que la génération MSI nécessite Windows et la fonctionnalité VBScript.

Le fichier Money fictif figé `tests/fixtures/money-reference.mny` est versionné : le test de lecture s’exécute dans Actions sur Linux et Windows. Le parcours WebDriver standard est lancé sous Linux avec une WebView et une base temporaires, y compris l’import Money. Le parcours des dialogues natifs et les tests WebDriver sous Windows ne sont pas lancés par ce workflow. Un résultat vert vérifie la compilation et les tests automatisés, mais ne remplace pas une recette de l’interface sous Windows.

Les objectifs et les limites des différentes suites sont détaillés dans la [revue de qualité des tests](../docs/qualite-tests.md).

### Mises à jour des dépendances

[Dependabot](../.github/dependabot.yml) vérifie chaque semaine les dépendances Yarn de l’application, les dépendances Cargo et les actions GitHub. Les mises à jour mineures et correctives sont regroupées par écosystème ; les mises à jour majeures restent séparées pour faciliter leur examen. Les pull requests passent par les vérifications GitHub Actions. La configuration prend effet une fois ajoutée à la branche par défaut du dépôt.

### Formatage du code

Depuis le répertoire `kresus`, `yarn format` applique Prettier aux fichiers TypeScript, CSS et HTML et `rustfmt` aux sources Rust. `yarn format:check` vérifie les mêmes fichiers sans les modifier. Les deux formateurs utilisent une largeur cible de 100 caractères ; les requêtes SQL et certains blocs HTML inclus dans des chaînes peuvent nécessiter une mise en forme manuelle.

### Parcours Tauri avec WebDriver sous Linux

Le parcours `e2e/tauri-smoke.mjs` lance la vraie application dans sa WebView, avec une base fictive temporaire de 12 000 opérations. Il vérifie la navigation, la pagination et le filtre « À pointer », puis la création d’un compte, la gestion d’une opération avec commentaire et son pointage, la création, la modification et la suppression d’un virement, la gestion des catégories, ainsi que la création, la modification ponctuelle et de série, la modification d’une occurrence future, l’enregistrement et la suppression d’une échéance. Il vérifie la prévision du solde à trois tailles de fenêtre, ainsi que l’ouverture du détail en cliquant sur le graphique. Il contrôle aussi la recherche, les limites par nombre et par date, les retards depuis le foyer, un virement récurrent et les totaux du rapport de dépenses avec exclusion des virements. Avec le fichier fictif versionné `tests/fixtures/money-reference.mny`, il vérifie également l’aperçu Money, la création d’une nouvelle base et son contenu SQLite (compte, catégories, opérations, échéances, solde et enregistrement d’un virement récurrent). On peut spécifier son emplacement avec `KRESUS_MONEY_SAMPLE` ; ce test attend les valeurs du fichier de référence (comptes de 1 000 € et 2 000 €, opérations ordinaires de −100 € et −25 €, trois virements de 100 €, neuf échéances et 138 catégories). Ce fichier est obligatoire pour ce parcours. Les confirmations intégrées sont explicitement annulées puis validées dans cette base temporaire. Les durées affichées incluent les échanges WebDriver ; ce parcours ne couvre pas encore tous les scénarios du document initial et ne remplace pas une inspection visuelle manuelle.

Il nécessite `tauri-driver`, le pilote WebKitGTK, `dbus-run-session` et, pour un affichage virtuel, `xvfb-run`. Le bus D-Bus isolé évite que le test ne transmette ses demandes à une application Kresus déjà ouverte. Sur Ubuntu 26.04, les paquets système correspondants sont `webkitgtk-webdriver` et `xvfb` ; le pilote Tauri s’installe avec `cargo install tauri-driver --locked`. Les noms des paquets peuvent varier selon la distribution. Après installation :

```sh
nvm use
yarn tauri build --debug --no-bundle --features e2e
xvfb-run -a dbus-run-session -- yarn test:e2e
```

Le test d’un collage réel est facultatif : il nécessite `xclip` et un affichage X11 isolé pour éviter de modifier le presse-papiers de la session utilisateur. Par exemple :

```sh
GDK_BACKEND=x11 KRESUS_E2E_CLIPBOARD=1 xvfb-run -a dbus-run-session -- yarn test:e2e
```

Sans cette option, le parcours signale que le test du presse-papiers est ignoré ; les formats de montants sont aussi couverts par les tests TypeScript.

Le test crée son propre répertoire de données temporaire et ne charge pas la base habituelle. La fonctionnalité de compilation `e2e`, active uniquement en mode debug, remplace les boîtes de dialogue natives de l’import et de la sauvegarde/restauration par les chemins du fichier de référence et de la nouvelle base temporaire : la WebView, les commandes Tauri, le lecteur et SQLite sont réels, mais les sélecteurs réels sont vérifiés séparément par le parcours natif décrit ci-dessous. Sans cette fonctionnalité, le test Money attendrait les boîtes de dialogue natives. Les ports sont choisis localement pour la durée du test. Un exécutable `tauri-driver` situé ailleurs peut être fourni avec la variable `TAURI_DRIVER`.

### Dialogues natifs et inspection visuelle sous Linux

Le parcours complémentaire vérifie le raccourci natif d’ouverture et l’accès à « À propos » par le menu, puis utilise les vrais sélecteurs GTK : il vérifie leur ouverture et leur annulation au clavier, puis crée une sauvegarde, l’ouvre et revient à la base habituelle. Il utilise une base temporaire et retire les chemins substitués par la compilation `e2e`. Sous Linux avec WebKitGTK, `xdotool`, Xvfb, D-Bus et le sélecteur GTK disponibles :

```sh
GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=GNOME xvfb-run -a dbus-run-session -- yarn test:e2e:native
```

La session X11 et le bus D-Bus doivent être isolés : le script pilote les fenêtres au clavier. Le test cible les titres des sélecteurs GTK observés dans cet environnement ; d’autres portails ou bureaux peuvent présenter des variantes. Il vérifie aussi la confirmation de restauration, le rejet d’un fichier invalide, l’ouverture et la migration d’une base de test au schéma ancien, le refus d’une base incompatible, ainsi que des cas métier de retards et de rapport de dépenses sur deux comptes. Avec le fichier Money fictif versionné, il vérifie l’aperçu, l’annulation du choix de destination, puis la création effective et le contenu SQLite de la base importée. Le parcours standard vérifie de plus le refus d’une sauvegarde sur un fichier existant ; pour ce cas, le chemin est fourni par la compilation de test plutôt que par le sélecteur natif. La suite WebDriver standard vérifie aussi les parcours clavier de plusieurs formulaires, le registre et l’éditeur, ainsi que leur affichage et celui du formulaire d’échéance à 900 × 620, 1 100 × 700 et 1 280 × 820 pixels. Pour conserver des captures à inspecter, définir `KRESUS_E2E_SCREENSHOTS` avec un répertoire de destination avant le lancement.

### Mesure de performance

Deux scénarios facultatifs construisent chacun 10 000 opérations fictives sur dix ans, sans toucher à la base de l’utilisateur. Un scénario Rust supplémentaire mesure un cas extrême de 60 000 opérations sur vingt ans pour un seul compte :

```sh
yarn test:performance
cargo test --manifest-path src-tauri/Cargo.toml performance_reference_10000_operations -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml performance_reference_60000_operations -- --ignored --nocapture
```

Le premier mesure le registre, un filtre, le pointage et les changements de compte dans jsdom avec un backend simulé. Le second utilise une base SQLite temporaire et mesure l’insertion groupée, les soldes, la lecture complète et paginée avec totaux, leur sérialisation JSON et les suggestions de destinataires. Les mesures sont indicatives, sans seuil automatique : elles varient selon la machine et la charge. Le DOM simulé ne mesure ni le rendu de la WebView Tauri, ni le transport réel entre Rust et l’interface ; le parcours WebDriver ci-dessus les exerce séparément, avec les délais propres à l’automatisation. L’insertion mesurée ne représente pas un import Money.

À titre de référence, une mesure manuelle du 6 novembre 2026 a utilisé une compilation release sous Linux, WebKitGTK dans Xvfb et un processeur AMD Ryzen 9 7950X3D. La base fictive contenait 12 000 opérations, dont 10 000 sur le compte affiché. La mémoire indiquée est la PSS totale des processus Kresus et WebKit ; le CPU est exprimé en pourcentage d’un cœur :

| Scénario | Mémoire PSS | CPU moyen |
| --- | ---: | ---: |
| Registre au repos, pendant 10 s | 158 Mio | 0,3 % |
| Passage automatisé de 20 pages en environ 2,5 s | 199 Mio | 59 % |
| Au repos pendant 6 s après ouverture des graphiques | 211 Mio | 2,1 % |

Il s’agit d’une mesure ponctuelle, réalisée séparément des scripts de performance ci-dessus. L’affichage virtuel, la machine et l’activité de la WebView influent sur les résultats ; une comparaison doit reprendre autant que possible les mêmes conditions.

Dans les mêmes conditions, une seconde mesure avec la base extrême de 60 000 opérations sur vingt ans, dont 50 000 sur le compte affiché, a donné :

| Scénario | Mémoire PSS | CPU moyen |
| --- | ---: | ---: |
| Registre au repos, pendant 10 s | 194 Mio | 0 % |
| Passage automatisé de 20 pages en environ 3,9 s | 222 Mio | 75 % |
| Au repos pendant 6 s après ouverture des graphiques | 227 Mio | 2,2 % |

Le CPU au repos est arrondi : aucune activité n’a été observée à la résolution de cette mesure, ce qui ne garantit pas une utilisation nulle en permanence.

Après optimisation de la pagination, une nouvelle mesure ponctuelle dans les mêmes conditions sur la base extrême a donné 2,52 s pour les 20 changements de page, contre 3,85 s auparavant ; le CPU moyen pendant ce parcours est passé de 75 % à 62 % d’un cœur. La mémoire PSS médiane était de 194 Mio au repos et 243 Mio pendant la pagination, contre 194 et 222 Mio avant. Ces résultats ne démontrent donc pas de réduction de mémoire et restent sensibles à l’activité de la WebView.

Un parcours ultérieur de 120 pages sur la même base a identifié des allocations répétées de formateurs de dates et de montants dans la WebView. Après leur réutilisation, deux mesures ponctuelles ont donné, après 20 secondes de repos : 241 contre 203 Mio de PSS après 20 pages, puis 342 contre 237 Mio après 120 pages. Le parcours des 20 premières pages a pris 2,76 contre 2,62 s, avec un CPU moyen de 57 % contre 54 % d’un cœur. La mémoire reste supérieure à celle du lancement ; ces mesures ne permettent pas, à elles seules, de conclure à une fuite ou de garantir les mêmes gains sur une autre machine.

### Générer une base de test

Le script crée une base Kresus distincte avec 12 000 opérations fictives réparties sur dix ans, dont 10 000 sur le compte courant. Elle comprend chaque mois un salaire et une pension fictifs ; le nombre total reste fixé à 12 000 opérations. Il nécessite Python 3 et sa bibliothèque SQLite intégrée :

```sh
python3 scripts/generate_test_database.py
```

Les tests du générateur se lancent avec `python3 -m unittest discover -s scripts/tests`. Le script ne remplace jamais une base existante : pour obtenir les nouvelles données, choisir un nouveau nom de fichier.

Le fichier est créé dans `donnees-test/kresus-test-12000.kresus` et peut être ouvert depuis le menu « Fichier » de Kresus. Pour choisir un autre emplacement ou volume :

```sh
python3 scripts/generate_test_database.py --output donnees-test/extreme-60000.kresus --operations 60000 --years 20
```

Cette base extrême contient 50 000 opérations sur le compte courant et 10 000 sur le livret, du 29 octobre 2006 au 28 octobre 2026. Le script refuse d’écraser un fichier existant et utilise le schéma SQLite de l’application. Les données sont reproductibles et fictives. Git ignore les bases SQLite et leurs fichiers auxiliaires ; les fichiers déjà suivis ou ajoutés à l’index doivent toutefois être retirés de l’index séparément. Le test du générateur vérifie aussi la base extrême et son intégrité ; il utilise un fichier temporaire.

## Données et sauvegarde

La base SQLite `comptes.kresus` est créée dans le répertoire de données de l’application fourni par Tauri. Sous Linux, il s’agit généralement de `~/.local/share/com.kissifrot.kresus/`. Copier ce fichier lorsque l’application est arrêtée permet de le sauvegarder. La commande « Fichier → Ouvrir une base… » permet de sélectionner un autre fichier `.kresus` compatible, ouvert en lecture-écriture directement à son emplacement. Le nom du fichier actif apparaît dans la barre latérale ; « Revenir à la base habituelle » rétablit la base du répertoire utilisateur. Le choix ne persiste pas après redémarrage. Un double-clic sur un fichier `.kresus` lance Kresus ou transmet le fichier à la fenêtre existante ; la base est validée avant ouverture. Les installateurs déclarent cette association. Le double-clic et l’installation effective restent à valider sur Windows. Les fichiers qui ne portent pas l’extension `.kresus`, les bases incompatibles ou sans compte sont refusés ; aucun import Money ni génération de base volumineuse n’est effectué par cette commande. Les montants sont stockés, échangés entre Rust et TypeScript et calculés en centimes entiers ; les euros sont utilisés à la saisie et à l’affichage.

Les données d’exemple sont insérées uniquement à la création d’une nouvelle base. Une donnée d’exemple supprimée ne réapparaît pas au redémarrage, y compris pour les bases créées par une version précédente. L’initialisation peut également migrer les anciennes opérations utilisateur enregistrées dans le stockage local du prototype. Les détails et autres limites sont décrits dans la spécification.

## Organisation

Dans `src-tauri/src/`, `lib.rs` initialise Tauri et enregistre les commandes ; `database.rs` gère la connexion et l’initialisation SQLite et utilise `schema.sql`, partagé avec le générateur de données fictives. `database_tests.rs` vérifie notamment l’initialisation et la conservation des suppressions. `accounts.rs`, `transactions.rs`, `schedules.rs` et `categories.rs` regroupent commandes et logique métier. Les tests propres à chaque domaine se trouvent dans les fichiers suffixés `_tests.rs` ; `test_support.rs` fournit les éléments communs.

Dans `src/`, `main.ts` charge les données au démarrage. `accounts.ts`, `household.ts`, `transactions.ts`, `transfers.ts`, `schedules.ts`, `categories.ts` et `spending-report.ts` regroupent les vues et interactions par domaine ; `payees.ts` partage les suggestions de destinataires. `state.ts`, `types.ts` et `format.ts` contiennent l’état partagé, les types et les fonctions communes de présentation. `styles.css` contient les styles communs de l’interface.

## Import expérimental Microsoft Money

Pour enrichir le fichier fictif lors d’une prochaine session Windows, voir la [liste détaillée des exemples et informations à relever](../docs/prochain-fichier-money.md).

Dans le menu « Fichier », choisir « Importer Money… », sélectionner le fichier `.mny`, vérifier l’aperçu et choisir le type de chaque compte. L’import crée une **nouvelle** base SQLite à l'emplacement choisi, sans écraser de fichier existant, puis l'ouvre jusqu'au prochain redémarrage. La lecture est locale et ne nécessite pas Java. Les fichiers de plus de 16 Mo ne sont pas encore acceptés.

L’import des fichiers Money protégés par mot de passe est hors périmètre du projet. Cette première version lit les fichiers MSISAM Jet 4 récents sans mot de passe, les comptes bancaires ouverts en euros, leurs opérations ordinaires et les catégories. Elle exclut les placements, importe les virements enregistrés correspondant aux signatures vérifiées et refuse les ventilations ainsi que les opérations ou catégories non représentables. Chaque écriture conserve son propre pointage. Les échéances mensuelles et certaines bimestrielles reconnues, sans limite ou avec une date de fin et un nombre d’occurrences concordants, ainsi que les séries trimestrielles de débit non commencées et sans limite observées, sont importées ; le virement bimensuel vérifié (15 et fin de mois, non commencé et sans limite) est importé ; les autres variantes bimensuelles non vérifiées restent signalées ; les autres sont signalées avant l’import. Les séries mensuelles de débit déjà partiellement enregistrées sont aussi importées pour la configuration vérifiée, en conservant la prochaine occurrence et le jour d’ancrage. Les autres séries commencées et les limites incohérentes restent non prises en charge. Les limites acceptées sont stockées sous forme de date de fin inclusive. Un détail dépliable et copiable indique leur identifiant Money, destinataire, compte, date et motif connu, même pour une liste longue. Les deux comptes doivent être sélectionnés pour importer un virement enregistré ou récurrent. La méthode de paiement par chèque est reconnue pour la signature de débit vérifiée sur le fichier de référence ; les autres méthodes sont signalées dans l’aperçu et restent non précisées. Les commentaires des échéances peuvent être saisis dans Kresus et sont repris lors de leur enregistrement ; leur import depuis Money reste à vérifier sur un fichier contenant des exemples. Les références Money sont conservées dans un champ distinct, sans interprétation comme numéros de chèque ; les références déjà placées dans des commentaires par une ancienne version restent dans ces commentaires ; les statuts Money pointé et rapproché sont regroupés. Certaines variantes Money ne sont pas encore prises en charge. L'aperçu affiche au plus 100 opérations ; l'import ne se limite pas à ces 100 lignes. La compatibilité Windows reste à valider sur une installation Windows.
