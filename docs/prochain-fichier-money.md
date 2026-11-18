# Préparer le prochain fichier Money fictif

## Avant de commencer

- Travailler sur une copie du fichier fictif de référence, sans mot de passe ni données bancaires réelles. Conserver le fichier d’origine et ses exemples pour comparer les soldes et les états de pointage.
- Enregistrer les nouvelles opérations, fermer le fichier, puis le rouvrir dans Money avant de relever les résultats.

## Priorité · opérations ventilées

Ajouter ces trois opérations au compte courant, dans le même mois passé. Utiliser des libellés distincts pour les retrouver dans le registre.

| Libellé | Montant total | Détail des parts | État dans Money |
| --- | ---: | --- | --- |
| Test ventilation courses | −100,00 € | −80,25 € en alimentation et −19,75 € en entretien | Non pointée |
| Test ventilation facture | −35,41 € | −20,10 € en logement et −15,31 € en services | Pointée |
| Test ventilation remboursement | +50,50 € | +40,25 € en remboursement santé et +10,25 € dans une autre catégorie | Rapprochée, si Money permet de conserver les autres états de pointage |

- Utiliser au moins une sous-catégorie et noter son chemin complet tel qu’il apparaît dans Money. Les noms de catégories du tableau sont des exemples.
- Sur le premier achat, saisir un commentaire général et un commentaire différent sur chacune des deux parts.
- Si Money accepte une part de sens opposé, ajouter un quatrième cas nommé « Test ventilation remise ». Saisir un débit de **−25,40 €**, avec **−28,40 € d’achat** et **+3,00 € de remise**. Noter son état de pointage affiché.

### Résultats attendus dans Kresus

| Cas saisis | Effet sur le solde du compte | Dépenses nettes ajoutées au rapport | Lignes ajoutées au registre |
| --- | ---: | ---: | ---: |
| Les trois cas principaux | −84,91 € | +135,41 € | 3 |
| Avec le cas de la remise | −110,31 € | +160,81 € | 4 |

Chaque opération doit avoir une seule ligne et un seul pointage. Les états Money « Pointée » et « Rapprochée » apparaissent tous deux comme pointés dans Kresus. Vérifier les montants et commentaires de chaque part, le chemin des sous-catégories et la répartition des débits dans le rapport de dépenses.

## Vérifications facultatives encore ouvertes

- **Méthodes de paiement des échéances.** Si Money propose des choix distincts pour un prélèvement et un virement automatiques, créer un exemple de chaque et relever le libellé exact affiché après enregistrement.
- **Références des opérations.** Relever le numéro affiché, ses éventuels zéros initiaux et la méthode de paiement sur la fiche d’un chèque fictif. Si Money le permet, faire de même pour une opération avec une référence et un autre moyen de paiement.
- **Calendrier et limites d’échéances.** Exemples utiles si l’occasion se présente : série bimensuelle qui démarre hors du 15 et de la fin du mois, échéance du 31 janvier d’une année bissextile, date de fin saisie entre deux occurrences ou occurrence ignorée d’une série limitée. Relever la date saisie et les dates effectivement affichées, ainsi que le nombre d’occurrences restant si Money l’indique.

Les cas déjà vérifiés et leurs captures sont documentés dans [l’étude de l’import Money](etude-import-money.md).

## À rapporter sur Linux

1. Placer la copie finale du `.mny` sous un nom distinct dans `references/`. Le fichier figé `kresus/tests/fixtures/money-reference.mny` sert de point de comparaison.
2. Joindre une capture du registre et une par ventilation après réouverture. Elles doivent montrer le compte, les dates, les montants, le pointage, le détail des parts, les catégories et les commentaires. Noter séparément les valeurs absentes des captures.
3. Relever le solde affiché par Money après les ajouts et signaler toute différence entre ce qui a été saisi et ce que Money affiche.
