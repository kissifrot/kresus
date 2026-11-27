# Qualité et limites des tests

Les tests sont utiles lorsqu’ils protègent une règle observable : montants et pointage d’un virement, conservation des données après une erreur, dates et limites des échéances, ou encore confirmation avant une suppression. Leur nombre ou le pourcentage de couverture ne suffisent pas à établir leur efficacité.

Les tests Rust utilisent SQLite et vérifient notamment les annulations et les deux écritures liées. Les tests TypeScript de l’interface utilisent un backend simulé : ils vérifient les interactions et l’affichage, mais ne prouvent pas à eux seuls l’intégration avec Rust. Le parcours WebDriver standard teste la vraie WebView et SQLite avec une base temporaire ; il est exécuté sous Linux dans la CI. Le parcours des dialogues natifs s’exécute séparément et n’est pas lancé par la CI.

Les calculs de récurrence partagent les cas de référence [`recurrence-cases.json`](../kresus/tests/fixtures/recurrence-cases.json) entre les tests Rust et TypeScript. Ils vérifient les dates enregistrées et projetées, les fins de mois, les années bissextiles et les limites de série, sans appeler une implémentation depuis l’autre.

Les suites d’import Money vérifient le décodage, les comptes, le pointage, les virements, les ventilations et les échéances prises en charge. Les parcours Tauri vérifient le contenu SQLite après import avec `kresus/e2e/check_money_import.py`. Pour ajouter un cas de test, utiliser des données synthétiques et vérifier aussi les métadonnées avant de joindre un fichier à une contribution.

Les tests d’import OFX vérifient la validation de l’aperçu, les filtres paginés, les actions groupées et les rapprochements sans ambiguïté. Les tests Rust couvrent aussi la détection des doublons et l’annulation de l’import en cas d’erreur.

Des mutations ciblées sur le calcul des fins de mois et sur la conservation du pointage Money ont provoqué des échecs dans les tests correspondants. Ces essais vérifient que ces règles sont couvertes.

Les tests de performance restent des mesures manuelles sans seuil automatique ; ils ne garantissent pas qu’une régression de vitesse fera échouer la CI. Les tests WebDriver sous Windows et une inspection visuelle sur les systèmes distribués restent à réaliser.
