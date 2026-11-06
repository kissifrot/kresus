# Préparer le prochain fichier Money fictif

Cette checklist rassemble ce qu’il reste à observer dans Money pour poursuivre l’import, en une seule session si possible. Les captures et les valeurs demandées servent à comprendre le fichier et à vérifier les résultats de l’import : il n’est pas nécessaire de connaître son format interne.

## Avant de commencer

- Utiliser le fichier fictif actuel, sans mot de passe ni données bancaires réelles. En conserver une copie intacte, puis travailler sur une copie distincte.
- Garder les exemples existants : ils permettent de comparer le fichier et les captures avant et après les ajouts. Les fichiers `.mny` sont exclus de Git.
- Prendre les captures en laissant visibles le nom de l’échéance ou de l’opération, le compte, les dates et les valeurs utiles. Faire plusieurs captures si une fenêtre ne montre pas tout ; les nommer de façon à retrouver facilement l’exemple concerné.
- Pour chaque exemple, noter les valeurs qui ne sont pas lisibles sur les captures et toute différence entre ce qui a été saisi et ce que Money affiche après enregistrement. Ne pas deviner une valeur que Money ne montre pas : noter simplement qu’elle n’est pas visible.
- À la fin, enregistrer et fermer le fichier, le rouvrir une fois pour vérifier que les données et les prochaines dates sont conservées, puis le fermer avant d’en faire une copie.

## Déjà couvert : inutile de le recréer

- Des virements enregistrés dans les deux sens entre le compte courant et le livret A, avec des états de pointage distincts selon les écritures. Les exemples observés sont importés et testés.
- Deux séries mensuelles non commencées à durée limitée : 200 € jusqu’au 4 août 2027 et 300 € jusqu’au 19 mars 2027. Money calcule aussi un nombre d’occurrences lorsqu’une date de fin est saisie.
- Une série mensuelle limitée à trois occurrences dont deux sont enregistrées les 6 octobre et 6 novembre 2026 ; la prochaine affichée est le 6 décembre. Cette configuration est importée et testée.
- Une opération avec commentaire, importé, et une opération avec une référence de chèque dont la signification exacte reste à vérifier ci-dessous.

## À vérifier en priorité

### 1. Dates réelles des échéances Orange et EDF

Les libellés Money « Bimensuelle » pour Orange et « Bimestrielle » pour EDF ont été observés. Une projection avait été confirmée, mais les deux occurrences Orange en retard observées ensuite ne concordent pas avec elle. L’import de cette fréquence Orange est donc suspendu. Il faut relever les dates effectivement attribuées à chaque série, sans supposer leur intervalle.

Pour **Orange**, relever les deux occurrences manquantes ou en retard et au moins une date suivante si Money les affiche. Pour **EDF**, relever la prochaine date et les deux suivantes si possible. Pour chaque série :

1. Capturer sa fiche ou sa ligne de synthèse avec son libellé, son montant, son compte, sa périodicité exacte et sa prochaine date. Pour Orange, montrer également le compte de destination du virement s’il est visible.
2. Capturer la vue des retards ou la liste détaillée montrant les dates des occurrences concernées. Sélectionner chaque date utile dans le calendrier et capturer la liste des échéances de ce jour, avec le nom et le montant de la série visibles.
3. Noter dans l’ordre les dates effectivement associées à la série et préciser si chacune est en retard, prochaine ou future. Indiquer la date de référence affichée par Money si elle est visible.
4. Après fermeture et réouverture du fichier, vérifier et noter si la prochaine date et les retards sont identiques.

**Attention :** un jour en gras dans le calendrier indique qu’au moins une échéance existe ce jour-là ; à lui seul, il ne permet pas de savoir si elle appartient à Orange ou à EDF. Une capture du mois entier est utile pour se repérer, mais il faut aussi sélectionner les jours concernés pour montrer leur détail. Si Money ne permet pas d’afficher certaines occurrences futures ou leur détail, capturer ce qu’il montre et le signaler ; ne pas enregistrer ou modifier ces séries uniquement pour faire apparaître des dates.

| Série | Périodicité affichée | Dates attribuées à la série et état de chacune | Capture(s) / remarque |
| --- | --- | --- | --- |
| Orange | À relever | Deux retards, puis date suivante si visible | |
| EDF | À relever | Prochaine date, puis deux suivantes si visibles | |

### 2. Méthodes de paiement des échéances

Créer une échéance fictive pour **chaque méthode proposée par cette version de Money**, notamment chèque, virement automatique, prélèvement et « autre » si ces choix existent. Une capture de la liste déroulante ouverte permettra de connaître les choix réellement proposés.

Autant que Money le permet, utiliser le même compte, montant, date de début, périodicité et catégorie ; donner à chaque échéance un destinataire distinct et explicite, par exemple `Test méthode chèque` ou `Test méthode prélèvement`. Si une méthode impose d’autres paramètres ou un autre type d’échéance, noter la différence.

Pour chaque exemple :

- Capturer le formulaire renseigné avant validation et la fiche ou la synthèse après création, avec le destinataire, la méthode affichée, le compte, le montant, la date et la périodicité visibles.
- Noter le libellé exact de la méthode et le destinataire correspondant. Si un numéro de chèque est proposé, saisir un numéro fictif, le noter exactement et capturer le champ ; sinon, indiquer que ce champ n’est pas proposé.
- Si l’interface ne montre pas tous les paramètres ensemble, prendre plusieurs captures. Vérifier après réouverture que la méthode est toujours affichée.

| Destinataire | Méthode exacte | Compte et montant | Première date et périodicité | Numéro éventuel / captures |
| --- | --- | --- | --- | --- |
| | | | | |

### 3. Autres périodicités proposées

Capturer la liste déroulante des périodicités. Pour chaque périodicité supplémentaire proposée et pertinente, notamment la **trimestrielle**, créer une série fictive distincte avec un destinataire explicite. Conserver les autres paramètres identiques lorsque c’est possible.

Capturer la fiche après création et, pour chaque date visible, le détail du jour sélectionné dans le calendrier comme indiqué plus haut. Noter le libellé exact, la date de départ saisie, la prochaine date affichée et les deux ou trois dates suivantes **réellement visibles**. Si Money ne les montre pas, l’indiquer sans les déduire.

| Destinataire | Périodicité exacte | Date de départ saisie | Prochaine date et dates suivantes visibles | Capture(s) / remarque |
| --- | --- | --- | --- | --- |
| | | | | |

## Compléments utiles si le temps le permet

### Numéros et méthodes des opérations

L’opération avec une référence de chèque et celle avec commentaire existent déjà. Pour identifier précisément les champs sans assimiler toute référence à un numéro de chèque :

- Capturer la fiche de l’opération existante et sa ligne dans le registre, en montrant la méthode, le numéro tel qu’affiché, le destinataire, le montant, la date et le commentaire lorsqu’ils sont visibles. Noter le numéro exactement, y compris les zéros éventuels, et préciser s’il s’agit d’un numéro de chèque ou d’une autre référence selon Money.
- Si possible, ajouter un deuxième chèque fictif avec un numéro différent, puis une opération non payée par chèque comportant une référence si Money le permet. Capturer pour chacune la saisie et la ligne enregistrée, et noter le type et le numéro exacts. Ne pas compléter artificiellement les numéros avec des zéros.

### Fins de mois et limites de séries

- Créer une échéance mensuelle en fin de mois, par exemple le 31 janvier d’une année bissextile. Capturer sa fiche et le détail de chaque date visible en février, mars et avril ; noter les dates réellement affichées. Cela permettra de vérifier le comportement de Money en février et le retour éventuel au 31.
- Créer une série avec une date de fin saisie **entre deux occurrences**. Avant validation, capturer la date de début, la périodicité et la date de fin saisie ; après validation et réouverture, capturer la fin, le nombre d’occurrences et la dernière date affichés. Noter toutes ces valeurs, même si Money ajuste la fin.
- Si Money le permet facilement, créer une autre série limitée dont une occurrence est ignorée, sans modifier la série existante. Capturer sa configuration avant, l’action proposée, puis la prochaine date, le nombre restant et la date de fin après l’action et après réouverture. Noter ce qui a été fait et les dates concernées.

Ces variantes complètent les cas déjà vérifiés ; elles ne sont pas nécessaires pour conserver les exemples existants.

## À rapporter sur Linux

1. La copie finale du fichier fictif `.mny`, sous un nom distinct dans `references/`, ainsi que les captures correspondantes. Conserver aussi les copies initiale et finale sur Windows.
2. Les tableaux ci-dessus remplis ou des notes associant clairement chaque capture à son exemple. Pour les occurrences, indiquer les dates et leur état, pas seulement les jours en gras.
3. Les soldes affichés par Money après les éventuelles nouvelles opérations, pour chacun des comptes concernés. Signaler toute valeur qui n’a pas pu être affichée ou tout comportement surprenant.

Les fichiers protégés par mot de passe sont hors périmètre. Les opérations ventilées restent une fonctionnalité envisagée mais non décidée : ne pas en ajouter à ce fichier, car leur présence fait actuellement refuser l’import entier.
