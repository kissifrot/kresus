# Préparer le prochain fichier Money fictif

## Avant de commencer

- Travailler sur une copie du fichier fictif de référence, sans mot de passe ni données bancaires réelles. Conserver le fichier d’origine et ses exemples pour comparer les soldes et les états de pointage.
- Enregistrer les nouvelles opérations, fermer le fichier, puis le rouvrir dans Money avant de relever les résultats.

## Ventilations vérifiées dans le fichier du 18 novembre 2026

Les trois opérations ont été enregistrées le 18 novembre 2026 sur le compte courant. Le fichier fictif versionné contient ces cas.

| Libellé | Montant total | Détail des parts | État dans Money |
| --- | ---: | --- | --- |
| Test ventilation courses | −100,00 € | Alimentation −80,25 € · Auto/moto → Entretien/réparations −19,75 € | Non pointée |
| Test ventilation facture | −35,41 € | Équipement du logement → Travaux / Décoration −20,10 € · Abonnement/factures → Service d’entretien −15,31 € | Pointée |
| Test ventilation remboursement | +50,50 € | Autres revenus → Accident du travail +40,25 € · Autres revenus +10,25 € | Rapprochée |

Le fichier contient six parts avec leurs catégories et commentaires. Les trois opérations diminuent le solde de **84,91 €** et ajoutent **135,41 €** au rapport de dépenses. Le solde final du compte courant est de **−3 576,46 €**, comme dans les captures. Le registre Kresus montre trois lignes, avec la facture et le remboursement pointés.

La saisie Money essayée n’a pas permis de mélanger débit et crédit dans une même ventilation. Le cas de la remise n’a pas été ajouté au fichier.

## Vérifications facultatives encore ouvertes

- **Méthodes de paiement des échéances.** Si Money propose des choix distincts pour un prélèvement et un virement automatiques, créer un exemple de chaque et relever le libellé exact affiché après enregistrement.
- **Références des opérations.** Relever le numéro affiché, ses éventuels zéros initiaux et la méthode de paiement sur la fiche d’un chèque fictif. Si Money le permet, faire de même pour une opération avec une référence et un autre moyen de paiement.
- **Calendrier et limites d’échéances.** Exemples utiles si l’occasion se présente : série bimensuelle qui démarre hors du 15 et de la fin du mois, échéance du 31 janvier d’une année bissextile, date de fin saisie entre deux occurrences ou occurrence ignorée d’une série limitée. Relever la date saisie et les dates effectivement affichées, ainsi que le nombre d’occurrences restant si Money l’indique.

Les cas déjà vérifiés et leurs captures sont documentés dans [l’étude de l’import Money](etude-import-money.md).

## À rapporter sur Linux

1. Placer la copie finale du `.mny` sous un nom distinct dans `references/`. Le fichier figé `kresus/tests/fixtures/money-reference.mny` sert de point de comparaison.
2. Pour chaque nouveau cas, joindre les captures après réouverture et noter les valeurs absentes des captures.
3. Relever le solde affiché par Money après les ajouts et signaler toute différence entre ce qui a été saisi et ce que Money affiche.
