# Étude de faisabilité : import Microsoft Money

## Périmètre et méthode

Étude du fichier local `references/Money.mny`, ouvert en lecture seule avec Jackcess 4.0.11 et Jackcess Encrypt 4.0.3, sans mot de passe. Les bibliothèques et le programme d'inspection étaient temporaires ; aucune donnée n'a été importée et le fichier source n'a pas été modifié. Les observations ci-dessous concernent cet échantillon et ne prouvent pas la compatibilité de toutes les versions françaises de Money. La [documentation du modèle Money par Monize](https://github.com/kenlasko/monize/blob/main/docs/ms-money-data-model.md) est issue de rétro-ingénierie et sert d'hypothèse à confronter à Money.

Dans sa version initiale, le fichier est une base MSISAM. Il contenait deux comptes en euros, cinq lignes dans `TRN`, 140 lignes dans `CAT` et deux bénéficiaires dans `PAY`. Les tables d’échéances, de virements et de ventilations étaient vides. Ces cinq lignes étaient des écritures réelles selon le champ `frq` ; leurs montants monétaires n’avaient pas de fraction de centime. Les cinq valeurs `cs` valaient 0 : cet exemple ne permettait pas de valider les autres états de pointage.

## Ajouts du 30 octobre 2026

Le fichier enrichi comporte deux comptes bancaires en euros : le compte courant (solde initial de 1 000 €, deux débits de 100 € et 25 €, solde de 875 €) et un livret A (solde initial et calculé de 2 000 €). Il contient deux séries désormais importées : un débit mensuel de 120 € à partir du 31 octobre 2026 et un virement de 100 € du compte courant vers le livret, prévu le 15 octobre 2026. Les captures Money désignent ce dernier comme « bimensuel » ; le calendrier montre un intervalle de deux mois. Kresus prend maintenant en charge cette périodicité.

Dans ce fichier, les deux séries sont décrites dans `BILL`. Leurs modèles apparaissent dans `TRN` avec `frq = 3`, et le champ `cFrqInst` vaut respectivement 1 et 2. Le modèle de virement a deux lignes liées dans `TRN_XFER`, reliées aux deux comptes. Ces éléments ne constituent pas des opérations enregistrées : les importer dans le registre modifierait à tort les soldes. Le lecteur reconnaît ces deux séries et les importe ; les autres configurations non vérifiées produisent un avertissement. Les virements enregistrés correspondant aux signatures vérifiées sont désormais importés ; les ventilations restent refusées.

Les captures de Money sont des références pour les informations et le comportement métier ; Kresus conserve son interface simplifiée. Elles permettent notamment de vérifier la prochaine date, le retard et les échéances en fin de mois. L’import des séries à durée limitée reste à relier aux champs Money : le stockage SQLite et ses tests sont préparés, mais la signification exacte de `cInstMax` et `dtMax` doit être vérifiée sur des exemples créés dans Money avant d’activer la lecture. L’import des autres fréquences et des méthodes de paiement non identifiées reste à implémenter.

## Correspondance proposée

Les observations de cette section se rapportent à la version initiale ; les ajouts sont décrits ci-dessus.

| Money | Kresus | Observations et précautions |
| --- | --- | --- |
| `ACCT.hacct`, `szFull` | `accounts.id`, `name` | Garder une correspondance stable des identifiants pour l'import et les références. |
| `ACCT.at` | `accounts.kind` | L'échantillon comprend un compte bancaire (`0`) et un compte de placement (`5`). Le type bancaire ne distingue pas à lui seul courant et épargne ; demander le choix. Ne pas assimiler automatiquement un placement à une assurance-vie. |
| `ACCT.amtOpen` | `opening_balance_cents` | Décimal exact multiplié par 100 ; signaler les fractions de centime au lieu d'arrondir silencieusement. `hcrnc` rejoint `CRNC` : les deux comptes et la devise par défaut sont en EUR. Refuser ou signaler les autres devises. |
| `ACCT.hfi` → `FI.szFull` | `bank` | Aucune des deux lignes ne référence un établissement et `FI` est vide ; le champ peut rester vide, sans conclure qu'il est toujours absent. |
| `TRN.htrn`, `hacct`, `dt`, `amt` | identifiant, compte, date, montant | Sélectionner les écritures réelles et préserver les montants signés en centimes. Vérifier les indicateurs et cas particuliers avant toute généralisation. |
| `TRN.lHpay` → `PAY.szFull` | `transactions.label` | Deux écritures bancaires référencent chacune un bénéficiaire. Certaines versions utilisent `hpay` : détecter la colonne disponible. Les trois lignes de placement ont `lHpay = -1`. Prévoir un libellé explicite si le bénéficiaire manque. |
| `TRN.hcat` → `CAT.hcat` | `transactions.category` | Kresus conserve le libellé de catégorie sous forme de texte `parent · enfant`. Prévoir une catégorie de repli explicite si la référence pointe sur une racine technique ou est absente. |
| `TRN.mMemo` | `transactions.note` | Conserver les commentaires s'ils existent. |
| `TRN.cs` | `transactions.reconciled` | L'hypothèse documentée est 0 non pointé, 1 pointé et 2 rapproché. Kresus n'a qu'un booléen ; la distinction entre 1 et 2 serait perdue et doit être signalée et validée sur d'autres exemples. |
| `TRN.szId` | `transactions.cheque` | Deux références non nulles ne sont pas directement des chaînes de sept chiffres. Le format et leur signification doivent être vérifiés : ne pas les traiter automatiquement comme des numéros de chèque ni les tronquer. |
| `CAT.hcat`, `hcatParent`, `szFull`, `nLevel`, `hct` | `categories.id`, `parent_id`, `name` | Les 140 lignes appartiennent à l'arbre `hct=0` : deux racines techniques, 21 catégories et 117 sous-catégories. En retirant les racines, la hiérarchie correspond aux deux niveaux de Kresus. Aucune collision de nom entre les catégories principales, aucun nom vide ou invalide pour Kresus et aucune catégorie masquée n'ont été observés dans cet échantillon. Détecter les collisions et les profondeurs supplémentaires dans d'autres fichiers. |

La suppression des racines `revenus` et `dépenses` peut créer des collisions entre catégories homonymes dans d'autres fichiers ; il faut les signaler et proposer une résolution, pas les fusionner silencieusement. Les attributs fiscaux et les classifications supplémentaires de Money n'ont actuellement pas d'équivalent dans Kresus.

## Soldes et placements : limites à résoudre

Le compte bancaire comporte deux écritures ordinaires de −100 € et −25 €. Son solde initial `ACCT.amtOpen` est de 1 000 € ; la somme donne 875 €, ce qui correspond au solde affiché par Money et confirmé par l'utilisateur. `XACCT.amtBalance` contient une valeur aberrante pour ce compte et ne doit pas être utilisée comme référence fiable dans cet échantillon. Il reste à vérifier ce calcul sur d'autres fichiers et cas particuliers ; ne pas corriger automatiquement le solde initial pour forcer une concordance avec cette valeur.

Le compte de placement comporte trois lignes `TRN` avec un titre `hsec`, une action `act=1` et une ligne associée dans `TRN_INV`. Leur montant `TRN.amt` est nul et des quantités et prix sont stockés séparément. Kresus ne gère pas les titres, positions ni valorisations et le solde d'un compte y est une somme d'opérations en centimes. Traiter ces lignes comme des opérations ordinaires donnerait un résultat trompeur. L'import initial devrait les exclure explicitement et avertir que le compte et sa valorisation ne sont pas repris, jusqu'à définition d'un modèle adapté. La présence d'une valeur zéro dans `XACCT` ne prouve pas que la valeur du portefeuille est nulle.

## Prototype sans Java

Un prototype séparé utilise TypeScript et `mdb-reader` pour lire le fichier sans Java. Sur cet échantillon, les objets des comptes bancaires admissibles, des 138 catégories et des deux opérations concordent avec le lecteur Jackcess ; le solde du compte est de 875 €. Le prototype et la comparaison reproductible sont décrits dans [`kresus/scripts/money-prototype/README.md`](../kresus/scripts/money-prototype/README.md). Le lecteur est intégré à la WebView Tauri et fonctionne sans Java. La compatibilité Windows reste à vérifier.

## Première implémentation

L’import des fichiers protégés par mot de passe est hors périmètre du projet.

Un import expérimental avec aperçu est désormais disponible : voir les prérequis et limites dans le README de `kresus`. Il crée une nouvelle base, conserve les références dans les commentaires et importe les virements enregistrés vérifiés et refuse les fichiers contenant des ventilations. Les échéances mensuelles et bimestrielles sans limite reconnues sont importées. La signature observée pour l’échéance « par chèque » est reconnue ; les autres méthodes sont signalées comme non identifiées. Un virement interne ne suffit pas à déduire la méthode Money : l’exemple fourni apparaît comme « Autre ». Les numéros de chèque ne sont pas déduits de `szId`. La prise en charge des placements reste à concevoir. Celle des opérations ventilées reste à décider.

## Démarche initiale et suites

Les trois premières étapes ont été réalisées pour les données prises en charge ; la quatrième reste à poursuivre sur d’autres fichiers.

1. Créer un lecteur local en lecture seule, sans envoi du fichier ou du mot de passe. Évaluer l'intégration et la distribution de Jackcess et d'un environnement Java, ou une autre bibliothèque compatible, ainsi que leurs licences. La preuve de lecture ne démontre pas qu'un lecteur Rust est disponible.
2. Produire un aperçu avant écriture : comptes et types à confirmer, devise, nombres de catégories et d'opérations, montants non représentables, soldes calculés et avertissements détaillés sur les éléments ignorés.
3. Importer d'abord dans une nouvelle base Kresus, en une transaction SQLite, en conservant les identifiants source pour relier correctement comptes, catégories et opérations. Définir explicitement la gestion d'un second import avant de permettre une fusion dans une base existante.
4. Comparer les résultats à Money, comme ici pour le solde initial et le solde du compte bancaire, puis reproduire ces vérifications sur d'autres fichiers. Tester avec des fichiers fictifs comportant des opérations pointées, chèques, virements, ventilations, échéances, devises différentes et catégories homonymes ; cet échantillon ne les valide pas.

Le fichier Money n'a pas été modifié. La concordance des soldes bancaires est confirmée sur cet échantillon. Tant que la représentation des placements n'est pas définie et que les autres cas métier ne sont pas testés, l'import ne doit pas être présenté comme complet.

## Exemples à ajouter au prochain fichier Money

Créer des échéances fictives facilement identifiables, puis noter leurs paramètres et conserver le fichier et si possible des captures :

- Deux virements déjà enregistrés entre comptes bancaires, dans des sens opposés, avec dates, montants, comptes et soldes affichés dans Money. Si possible, pointer un seul côté de l’un des virements.
- Une série à durée limitée par un nombre d’occurrences connu, avec première date et nombre précisés.
- Une série à durée limitée par une date de fin connue, avec première date et date de fin précisées.
- Des échéances identiques sauf leur méthode de paiement, avec un libellé distinct pour chacune : chèque, virement automatique, prélèvement et autre, ainsi que les autres choix proposés par Money. Préciser la méthode correspondant à chaque libellé.
- Si Money le permet, une échéance par chèque avec un numéro connu, pour vérifier où il est stocké.

Ces exemples permettront de confronter les champs aux valeurs affichées par Money avant d’étendre l’import ; les fichiers protégés par mot de passe restent hors périmètre.

L’étude du [modèle Money documenté par Monize](https://github.com/kenlasko/monize/blob/main/docs/ms-money-data-model.md#trn_xfer-transfer-pairs) décrit `TRN_XFER.htrnFrom` et `htrnLink` comme des références vers les deux écritures `TRN`, sans appariement approximatif par montant. Cette source issue de rétro-ingénierie constitue une hypothèse à confronter au prochain fichier.

Le stockage préparatoire des paires de virements est testé sur des données synthétiques : les deux opérations et leurs états sont conservés, la sélection des deux comptes est obligatoire, et les paires incohérentes sont refusées. La lecture effective des virements Money a depuis été activée pour la signature vérifiée sur le fichier fictif enrichi.

## Échantillon enrichi — 1er novembre 2026

Le fichier `references/Money.mny` mis à jour contient une paire de virements enregistrés entre le compte courant et le livret A : débit et crédit de 100 € datés du 31 octobre 2026, associés par `TRN_XFER`. La paire du virement récurrent déjà présente dans le précédent échantillon est distincte. Les statuts affichés et l’intention des données restent à confirmer dans Money.

Trois nouvelles échéances sont présentes. Deux lignes `BILL` mensuelles comportent respectivement les valeurs brutes `cInstMax = 10`, `dt = 2026-11-04`, `dtMax = 2027-08-04` et `cInstMax = 5`, `dt = 2026-11-19`, `dtMax = 2027-03-19`. La troisième a `cFrqInst = 0,5`. Ces valeurs ne démontrent pas à elles seules si la limite a été saisie comme nombre ou comme date, ni la signification de la périodicité ; elles doivent être confrontées aux paramètres affichés dans Money avant modification du lecteur.

Le fichier enrichi est désormais importé avec sa paire d’écritures liées et les pointages indépendants. Le test sur le fichier local et les parcours Tauri ont été adaptés ; le fichier `.mny` est exclu du dépôt, donc ce test reste ignoré dans GitHub Actions.

Money calcule automatiquement un nombre d’occurrences lorsqu’une date de fin est saisie, comme confirmé par l’utilisateur. La présence simultanée de `cInstMax` et `dtMax` ne permet donc pas de déduire directement lequel des deux paramètres a été choisi à la saisie. Le virement de 100 € entre les deux comptes a également été confirmé ; le détail du pointage et la correspondance des méthodes de paiement restent à préciser.

L’utilisateur confirme que seule l’écriture du compte courant est pointée pour le virement de 100 €. Dans le fichier, ses deux écritures portent respectivement `cs = 1` (débit du compte courant) et `cs = 0` (crédit du livret A), ce qui permet de vérifier la conservation indépendante du pointage pour cet exemple. Les valeurs affichées pour les deux échéances « Groupe Orange » ont également été confirmées : 10 occurrences jusqu’au 4 août 2027 pour 200 €, et 5 occurrences jusqu’au 19 mars 2027 pour 300 €. Le mode de saisie de chaque limite et les méthodes de paiement restent à préciser.

Le lecteur accepte les paires enregistrées dont les comptes, montants opposés et indicateurs correspondent à l’exemple observé ; les paires absentes, incohérentes ou vers des comptes non pris en charge sont refusées. La sélection doit inclure les deux comptes ou aucun. Les séries limitées de ce fichier restent signalées comme non importées.
