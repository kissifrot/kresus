# Kresus — spécification et état du projet

Ce document décrit l’application telle qu’elle existe et les besoins connus restant à réaliser. Il complète la spécification initiale « Outil de Gestion de nos Comptes.docx » fournie par le demandeur ; ce document d’origine, avec son annexe de catégories, se trouve dans ses documents personnels et n’est pas inclus dans ce dépôt. En cas de reprise, utiliser également le [guide de développement](kresus/README.md) et les captures dans [references](references/). Les points ci-dessous distinguent les comportements effectifs des besoins à venir.

## Objectif et conventions

Application de bureau de gestion financière familiale simple, adaptée aux usages français, avec montants en euros. L’interface s’inspire des repères de Microsoft Money sans chercher à en reproduire toutes les fonctionnalités. Code et commentaires en anglais ; interface et documentation en français. Les commentaires, y compris en TypeScript et surtout en Rust, expliquent brièvement les règles métier et choix non évidents. Privilégier la simplicité et la réutilisation du code.

## Fonctionnalités réalisées

### Navigation et comptes

- La barre latérale et le fil d’Ariane donnent accès aux comptes, regroupés en comptes courants, épargne et assurances vie. Le bouton « + » crée un compte avec son nom, son type, sa banque et son solde initial. Les soldes affichés sont les soldes actuels : solde initial augmenté de toutes les opérations.
- « Mon foyer » présente le total, les totaux par type, les soldes de chaque compte et un accès à chaque registre. « Comptes » présente la liste détaillée et la création de comptes. L’application démarre actuellement sur le registre du premier compte, avec la liste des comptes dans la barre latérale.
- La vue du foyer affiche les cinq prochaines occurrences en attente par date, y compris celles en retard, et indique le compte et le sens du montant. Son lien « échéances en retard », affiché si nécessaire, ouvre la liste complète des retards, même si plus de cinq échéances sont concernées.

### Registre et opérations

- Le registre affiche date, numéro de chèque, destinataire/libellé, catégorie, éventuel commentaire, pointage, débit, crédit et solde après chaque opération. Les chèques sont saisis sur sept chiffres. Le pointage manuel indique que l’opération a été rapprochée du relevé bancaire ; il est réversible.
- On peut créer, modifier et supprimer des débits et crédits. La sélection d’une ligne ouvre un éditeur fixe sous la liste et masque le résumé du compte ; enregistrer ou annuler rétablit le résumé. Les propositions de destinataire, partagées entre création et modification, utilisent les libellés d’opérations existantes et acceptent une nouvelle saisie.
- Le registre affiche 100 opérations par page, avec navigation et accès direct par numéro de page. La pagination et les filtres sont appliqués côté SQLite : seule la page demandée est transmise à l’interface, avec les totaux et les soldes calculés sur l’historique complet.
- Les filtres couvrent toutes les opérations, celles à pointer, les pointées, les débits et les crédits. Les soldes après opération tiennent compte de l’ensemble des mouvements, même lorsqu’un filtre en masque certains. Le résumé utilise les opérations du compte sélectionné : montant et nombre des entrées et sorties du mois courant, solde actuel et nombre d’opérations à pointer.
- Un virement entre deux comptes distincts crée deux opérations liées. Sa modification et sa suppression mettent à jour ou suppriment les deux mouvements. Le bouton d’export a volontairement été retiré pour le moment.

### Échéances

- Création d’une série de débits, crédits ou virements, avec compte, destinataire/libellé, catégorie, montant, date de première échéance et périodicité mensuelle, trimestrielle, semestrielle ou annuelle. Un virement demande deux comptes distincts. Les propositions de destinataire sont disponibles à la création et à la modification.
- Le calendrier mensuel possède des commandes de mois précédent, mois suivant et retour au mois courant. Il montre les occurrences en attente et les dates futures calculées comme des « Prévisions ». Une prévision n’est pas directement enregistrable ou modifiable : seule la prochaine occurrence en attente de chaque série l’est.
- La suppression, accessible sur une occurrence en attente ou une prévision, supprime après confirmation toute la série et ses occurrences futures ; les opérations déjà enregistrées restent dans les comptes.
- Une modification peut concerner la prochaine occurrence uniquement, ou cette occurrence et les suivantes. Une modification ponctuelle conserve les paramètres de la série ; la périodicité appartient à la série. L’enregistrement crée une opération non pointée, ou deux opérations liées pour un virement, puis avance la série d’une occurrence dans une transaction SQLite. L’opération peut ensuite être pointée depuis son compte.
- Le jour d’origine est conservé pour calculer les échéances futures : si un mois est trop court, on utilise son dernier jour, puis on retrouve le jour d’origine lorsque possible. Les années bissextiles sont prises en compte.
- Une occurrence est en retard si sa date est strictement antérieure à la date locale du jour ; une échéance du jour n’est pas en retard. Le résumé affiche la prochaine date à venir et, si nécessaire, un lien vers toutes les occurrences en retard. Cette liste permet de les modifier ou de les enregistrer ; après un enregistrement, une autre occurrence de la même série peut encore être en retard. Le lien du foyer ouvre la même liste. Le retour au mois rétablit la liste normale.

### Catégories et dépenses

- Création, renommage, fusion et suppression des catégories et sous-catégories. Deux niveaux sont prévus. La suppression est refusée si la catégorie est utilisée ou contient des sous-catégories. Les fusions se font entre catégories de même niveau et répercutent les changements sur les opérations et les échéances, y compris les modifications ponctuelles.
- Le rapport de dépenses charge actuellement l’historique complet du compte indépendamment du registre paginé.
- La répartition des dépenses présente, sous forme de graphique, les débits par catégorie pour un compte et une période dont les dates sont incluses. Les crédits et les virements entre comptes sont exclus.

## Données et fonctionnement technique

Tauri 2 relie l’interface TypeScript à Rust. SQLite stocke les données dans `kresus.sqlite3`, dans le répertoire de données de l’application (`~/.local/share/com.kissifrot.kresus/` en général sous Linux). Les montants sont stockés, échangés entre Rust et TypeScript et calculés en centimes entiers ; les conversions en euros sont réservées à la saisie et à l’affichage. La base est initialisée au lancement ; les anciennes opérations utilisateur du prototype peuvent être migrées depuis le stockage local du navigateur.

**Données d’exemple :** des comptes, opérations et échéances de démonstration sont insérés à la création d’une nouvelle base uniquement. Une base existante, y compris issue d’une version précédente, ne reçoit pas de nouveau ces données : une donnée d’exemple supprimée reste supprimée. Le schéma et les données initiales sont créés dans une même transaction. Les catégories initiales sont constituées des libellés existants et de quelques catégories de base ; toute l’annexe du document d’origine n’est pas préchargée.

Les séries, leurs jours d’ancrage, éventuelles modifications ponctuelles et destinations de virements sont conservés dans des tables distinctes. Les opérations liées par un virement et les mises à jour de séries sont enregistrées de manière atomique. Les sauvegardes consistent actuellement à copier le fichier SQLite lorsque l’application est arrêtée. Depuis la barre latérale, on peut ouvrir une autre base SQLite compatible Kresus ou revenir à la base habituelle. La sélection est temporaire : au redémarrage, la base habituelle est ouverte. Le fichier choisi est utilisé en lecture-écriture : les modifications lui sont appliquées directement. Avant le changement, Kresus vérifie l’intégrité SQLite, la présence des tables et colonnes nécessaires et au moins un compte ; un fichier incompatible est refusé sans remplacer la base active.

## Besoins initiaux et limites restant à traiter

- Séries à durée limitée : nombre d’occurrences, date de fin et arrêt automatique ne sont pas implémentés. La suppression manuelle de la série est disponible.
- La spécification initiale demande un tableau récapitulatif annuel, l’ensemble des dates d’une série et la modification d’une date future particulière. Le calendrier actuel navigue par mois ; seules les prochaines occurrences en attente sont modifiables, les dates suivantes étant des prévisions.
- La méthode de paiement d’une échéance (chèque ou virement automatique) et un numéro de chèque propre à l’échéance ne sont pas encore proposés.
- La spécification initiale envisage une liste complète des comptes à l’ouverture ; actuellement la liste est visible dans la barre latérale et le premier registre est ouvert.
- L’import de relevés bancaires et l’export d’opérations ne sont pas disponibles. Le pointage est manuel.
- Les données existantes et leurs migrations doivent être préservées lors de toute évolution du schéma.

Cette liste décrit les écarts constatés et ne constitue pas un ordre de priorité décidé par l’utilisateur.
