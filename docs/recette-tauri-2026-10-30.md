# Recette Tauri Linux — 30 octobre 2026

## Conditions

Application Tauri compilée en mode debug avec la fonctionnalité `e2e`, vraie WebView WebKitGTK sous Xvfb, pilotée par WebDriver. Une base temporaire contenant 12 000 opérations fictives a été utilisée ; la base habituelle n'a pas été ouverte. L'inspection visuelle a porté sur les captures de la WebView à 1 280 × 820 pixels. Les manipulations ont été réalisées par WebDriver, pas directement au clavier et à la souris. Les contrôles automatisables ont ensuite été intégrés à [`kresus/e2e/tauri-smoke.mjs`](../kresus/e2e/tauri-smoke.mjs) ; le collage réel est optionnel et nécessite un affichage X11 isolé.

## Parcours vérifiés

- Ouverture du registre, pagination et filtre « À pointer » ; navigation vers foyer, échéances, catégories et rapport de dépenses.
- Création d'un compte, sauvegarde, modification des données puis restauration : le solde et les données sauvegardés sont rétablis.
- Création, modification, pointage et suppression d'une opération avec commentaire et chèque ; recherche par commentaire, recherche sans résultat et réinitialisation. Le collage réel de `12,34 €` dans une opération a été vérifié avec la locale française dans la WebView Tauri.
- Création, modification et suppression d'un virement, avec vérification des deux comptes. Création et enregistrement d’un virement récurrent bimestriel depuis l’interface, avec vérification en SQLite des deux opérations liées et de leurs montants opposés.
- Création, renommage, fusion et suppression de catégories.
- Création, modification ponctuelle et de série, enregistrement et suppression d'une échéance ; modification d'une occurrence future depuis la vue annuelle.
- Série limitée à deux occurrences : les deux enregistrements sont créés, la série disparaît après le second et le numéro de chèque ne se répète pas. Pour une série mensuelle limitée par date, deux échéances en retard sont consultées et enregistrées depuis le foyer ; la date de fin est inclusive et la série disparaît après sa dernière occurrence.
- Rapport de dépenses : une période inversée est rejetée ; sur une période contenant un virement, le total affiché concorde avec un calcul indépendant sur SQLite et exclut le virement.
- Import du fichier Money fictif : aperçu, données importées et enregistrement d'un virement récurrent vérifiés. Les sélecteurs de fichiers natifs ont été remplacés par des chemins de test.
- Examen visuel du foyer, du rapport de dépenses, du calendrier, de la vue annuelle, des formulaires d'échéance et de l'aperçu Money. Aucun chevauchement majeur constaté dans ces conditions.

## Anomalies et points d'attention

- **Numéro de chèque incohérent — corrigé** : le formulaire d’échéance acceptait `123`, alors que le registre exigeait sept chiffres. La saisie et les commandes Rust sont désormais harmonisées ; une ancienne échéance comportant un numéro invalide doit être corrigée avant enregistrement.
- **Présentation des dates** : avec `LC_TIME=C.UTF-8`, les champs natifs de date étaient affichés en mois/jour/année. Une seconde session Tauri avec `LC_ALL=fr_FR.utf8` affiche bien jour/mois/année dans le formulaire d’échéance et le rapport de dépenses. Le rendu dépend donc de la locale de la WebView ; il reste à vérifier sur les autres environnements cibles.

## Non vérifié dans cette session

- La sélection native de la destination d’un import Money et la confirmation de restauration ont été vérifiées depuis dans les compléments ci-dessous.
- Navigation et cas particuliers au clavier, ergonomie minimale du lecteur d’écran, tailles de fenêtres supplémentaires et différences entre environnements graphiques.
- Tous les cas métier : gestion exhaustive des retards, rapport avec périodes et catégories variées, cas d'erreur et migration de bases réelles.
- Compilation et recette sous Windows ; variantes de fichiers Money non représentées par le fichier fictif.

## Complément Linux — 31 octobre 2026

- Les sélecteurs GTK d’ouverture de base, sauvegarde, restauration et import Money s’ouvrent et s’annulent avec Échap dans une session X11 et D-Bus isolée. Une sauvegarde a été créée au moyen du sélecteur, puis ouverte comme base avant le retour à la base habituelle. Ces vérifications figurent dans `kresus/e2e/native-dialogs.mjs`.
- La navigation Tab vers « Échéances », son activation avec Entrée et l’ouverture puis fermeture du formulaire avec Entrée et Échap sont testées par WebDriver. La navigation complète n’est pas auditée. Depuis cette recette, les lignes du registre sont accessibles au clavier et Entrée ouvre leur éditeur ; des tests couvrent également les virements.
- Le calendrier et le formulaire d’échéance ont été examinés à 900 × 620, 1 100 × 700 et 1 280 × 820. Le formulaire défile verticalement à la taille minimale ; son bouton d’enregistrement devient visible lorsqu’il reçoit le focus. Les contrôles de dimensions et d’accès au bouton figurent dans la suite WebDriver.
- La sélection native de la destination d’un import Money a été vérifiée depuis dans le complément ci-dessous.
- La sélection native du fichier Money fictif, l’affichage de son aperçu et l’annulation de l’import ont été vérifiés dans une session isolée ; ce parcours est ajouté à `kresus/e2e/native-dialogs.mjs`.

## Complément Linux — navigation et registre

- Les champs des formulaires de compte, opération, virement, catégorie, échéance et rapport sont parcourus par Tab dans la WebView ; les commandes de fermeture et certaines validations sont actionnées avec Entrée ou Échap. L’aperçu Money est également parcouru au clavier. Les contrôles sont intégrés à `kresus/e2e/tauri-smoke.mjs`.
- Le registre et l’éditeur d’opération ont été examinés et testés à 900 × 620, 1 100 × 700 et 1 280 × 820. L’éditeur reste accessible avec son bouton Annuler atteignable au clavier ; à la largeur minimale, le registre nécessite un défilement horizontal pour ses dernières colonnes.
- Ces scénarios ne constituent pas une preuve exhaustive d’accessibilité : la prise en charge des lecteurs d’écran est minimale et n’est pas prioritaire.

## Complément Linux — confirmations

- Les suppressions d’une échéance et d’une catégorie ainsi que la restauration utilisent une confirmation intégrée à la WebView. Les tests WebDriver vérifient son affichage, l’annulation et la validation ; la restauration vérifie aussi le rétablissement des données.
- Le parcours de restauration est également vérifié après sélection effective d’une sauvegarde dans le dialogue natif GTK, avec annulation puis validation, dans `kresus/e2e/native-dialogs.mjs`. Ces essais utilisent une base temporaire.

## Complément Linux — import natif et erreurs de sauvegarde

- Dans une session X11 et D-Bus isolée, le fichier Money fictif est sélectionné dans le dialogue natif, puis la sélection de destination est annulée et recommencée. La base créée est ouverte dans Tauri et ses comptes, opérations, catégories et échéances sont vérifiés directement dans SQLite.
- Une restauration confirmée depuis un fichier qui n’est pas une base SQLite affiche une erreur ; le fichier sélectionné et les données de la base active sont conservés. Le test compare les nombres de comptes et opérations et la somme des montants avant et après.
- Le parcours Tauri standard vérifie qu’une sauvegarde vers un fichier existant échoue sans remplacer son contenu ni altérer la base active ; ce cas utilise un chemin de test et non le sélecteur natif. L’interface est aussi testée avec une erreur de destination inaccessible simulée.
- Ces scénarios sont intégrés respectivement à `kresus/e2e/native-dialogs.mjs`, `kresus/e2e/tauri-smoke.mjs` et `kresus/tests/database.test.ts`. Ils utilisent des données temporaires.

## Complément Linux — cas métier et bases existantes

- Une copie de base dont le schéma représente une version antérieure est ouverte via le sélecteur natif : la migration ajoute les champs de paiement et les tables d’échéances absents, et conserve les comptes, opérations et échéances de test. Un fichier incompatible est ensuite refusé sans changer la base active. Cette vérification couvre ce schéma construit pour le test, pas toutes les versions historiques possibles.
- Deux séries en retard sont affichées par ordre chronologique et enregistrées ; leurs dates et montants sont vérifiés en SQLite, le compteur est actualisé et l’échéance du jour n’est pas considérée en retard.
- Le rapport est vérifié sur deux comptes, avec deux catégories, des bornes inclusives autour du 29 février 2020, une période d’un jour et un compte sans dépense. Les revenus et un virement interne sont exclus des totaux.
- Ces scénarios figurent dans `kresus/e2e/native-dialogs.mjs` et utilisent une base temporaire.

## Complément Linux — menus natifs

- Le raccourci Ctrl+O ouvre le sélecteur natif ; le menu « Aide » ouvre la fenêtre « À propos », avec son icône et la version de l’application. Les parcours des autres actions sont exercés au moyen du même événement que celui émis par le menu.
- Ces contrôles figurent dans `kresus/e2e/native-dialogs.mjs` ; ils ont été exécutés sous X11 et WebKitGTK. La vérification sous Windows reste à faire.
