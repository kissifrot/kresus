# Préparer le prochain fichier Money fictif

Cette liste regroupe les exemples utiles pour poursuivre l’import Money sans multiplier les passages entre Windows et Linux. Elle concerne un **fichier fictif**, sans mot de passe. Conserver une copie du fichier actuel avant de le modifier, puis copier le fichier enrichi dans `references/` sous un nom distinct. Ne pas y ajouter de données bancaires réelles. Les fichiers `.mny` sont exclus de Git.

## Déjà disponible

- Un virement enregistré de 100 € du compte courant vers le livret A : seul le côté compte courant est pointé. Il est importé et testé.
- Deux échéances mensuelles non commencées à durée limitée : 200 € jusqu’au 4 août 2027 (10 occurrences) et 300 € jusqu’au 19 mars 2027 (5 occurrences). Elles sont importées après vérification de la cohérence des limites.
- Une autre échéance dont la périodicité est encodée par `cFrqInst = 0,5` ; son libellé exact dans Money reste à relever.

Il n’est pas nécessaire de recréer ces exemples. Les conserver facilite la comparaison avant/après.

## À préparer en priorité

### 1. Identifier les méthodes de paiement des échéances

Créer une échéance fictive par méthode proposée par Money : notamment chèque, virement automatique, prélèvement et « autre », **si ces choix existent dans la version utilisée**. Inclure aussi les autres méthodes proposées. Utiliser le même compte, le même montant, la même date, la même périodicité et la même catégorie ; seul le destinataire doit distinguer les exemples. Par exemple : `Test méthode chèque`, `Test méthode prélèvement`, etc.

Pour chaque échéance, relever son destinataire et le libellé exact de la méthode affichée dans Money. Si un numéro de chèque peut être saisi sur une échéance, en ajouter un fictif et le noter ; sinon, indiquer que Money ne propose pas ce champ.

### 2. Identifier les périodicités

Relever d’abord le libellé exact de la périodicité de l’échéance EDF à 200 € commençant le 19 novembre 2026, celle dont la valeur brute est `0,5`. Prendre une capture si elle est ambiguë.

Créer ensuite une échéance pour chaque périodicité supplémentaire proposée par Money et pertinente pour le foyer. Conserver les autres paramètres identiques et utiliser des destinataires distincts, par exemple `Test périodicité trimestrielle`. Pour chacune, relever le libellé exact, la première date et les deux ou trois dates suivantes affichées par Money. Les périodicités mensuelle et bimestrielle de base sont déjà couvertes.

### 3. Vérifier une série à durée limitée déjà commencée

Créer **une nouvelle** série mensuelle limitée, avec un libellé distinct, une première date passée, un nombre d’occurrences connu et un montant fictif. Enregistrer une ou deux occurrences dans Money sans supprimer la série. Relever :

- la première date et le nombre d’occurrences choisis à la création ;
- le nombre et les dates des occurrences effectivement enregistrées ;
- la prochaine date, la date de fin et le nombre restant affichés après enregistrement ;
- les opérations correspondantes visibles dans le compte.

Cet exemple est distinct des deux séries limitées déjà présentes : celles-ci n’ont pas commencé et sont déjà prises en charge. Ne pas modifier ces deux exemples existants.

### 4. Ajouter un virement enregistré dans l’autre sens

Créer un virement fictif du **livret A vers le compte courant**, avec une date et un montant différents du virement existant. Si Money le permet, pointer uniquement un côté et noter lequel. Relever la date, le montant, les deux comptes et les soldes affichés après les virements. Cela permettra de vérifier les deux sens et les deux états de pointage indépendamment.

## Si c’est facile à préparer

- Ajouter une opération ordinaire avec un numéro de chèque connu, ainsi qu’une opération avec un commentaire distinct ; noter les valeurs affichées. Les références Money ne sont actuellement pas interprétées comme des numéros de chèque et les notes des échéances ne sont pas reprises.
- Ajouter une échéance en fin de mois, par exemple le 31 janvier d’une année bissextile, et noter les prochaines dates montrées par Money, y compris février et mars. Cela permettra de confronter l’ancrage de Money à celui déjà testé dans Kresus.
- Ajouter un exemple de date de fin saisie entre deux occurrences, puis noter la date saisie, la dernière occurrence et le nombre affichés par Money.

Les opérations ventilées restent un sujet à décider : inutile d’en ajouter à ce stade, car leur présence fait actuellement refuser l’import du fichier entier. Les fichiers protégés par mot de passe sont hors périmètre.

## À rapporter sur Linux

1. Le nouveau fichier `.mny` fictif, placé dans `references/` sous un nom distinct, et une copie conservée sur Windows.
2. Un tableau ou des captures montrant les paramètres et résultats demandés ci-dessus, surtout les correspondances entre destinataires et méthodes ou périodicités. Les dates, montants, comptes et états de pointage doivent rester lisibles.
3. Les soldes affichés par Money pour les comptes concernés après ajout des opérations et virements.

Ces éléments servent à vérifier les champs observés avant d’activer chaque nouveau cas d’import. Il n’est pas nécessaire de transmettre un mot de passe ni une base personnelle.
