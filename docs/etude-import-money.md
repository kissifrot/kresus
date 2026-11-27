# Notes techniques sur l’import Microsoft Money

Le lecteur ouvre les fichiers MSISAM Jet 4 pris en charge en lecture seule. Le décodage des pages suit la dérivation de clé de Jackcess Encrypt, sous licence Apache 2.0. Le lecteur TypeScript utilise `mdb-reader` dans la WebView Tauri. Pour les formats et les limites d’utilisation, voir le [guide de développement](../kresus/README.md#import-expérimental-microsoft-money).

## Comptes et opérations

| Champs Money | Rôle dans Kresus |
| --- | --- |
| `ACCT.hacct`, `szFull` | Identifiant et libellé du compte. Le type courant, épargne ou assurance vie peut être choisi dans l’aperçu pour chaque compte importable. |
| `ACCT.at`, `fClosed`, `hcrnc` | Sélection des comptes bancaires ouverts en euros. La devise est résolue dans `CRNC`. |
| `ACCT.amtOpen`, `TRN.amt` | Solde initial et écritures signées convertis en centimes. Le solde affiché est recalculé à partir des écritures importées. |
| `ACCT.mNum` | Si la valeur est renseignée, l’aperçu signale le numéro non repris. Le champ est brouillé dans Money et le numéro reste vide après l’import. |
| `TRN.frq` | La valeur `-1` désigne les écritures enregistrées. Les modèles des échéances ne sont pas ajoutés au registre. |
| `TRN.lHpay` ou `TRN.hpay`, `PAY.szFull` | Résolution du libellé du tiers. |
| `TRN.mMemo`, `TRN.cs` | Commentaire et pointage. Les états Money pointé et rapproché correspondent tous deux au pointage Kresus. |
| `CAT.hcat`, `szFull`, `nLevel`, `hct`, `hcatParent` | Reconstruction du catalogue et des libellés de catégorie à deux niveaux. Les racines techniques servent à déterminer la nature du groupe. |

`XACCT.amtBalance` peut diverger du solde reconstruit. Les placements utilisent notamment des quantités et des prix hors des écritures ordinaires. Leur valorisation est hors du périmètre de l’import actuel.

## Virements et ventilations

`TRN_XFER.htrnFrom` et `TRN_XFER.htrnLink` identifient les écritures d’un virement. Pour les paires enregistrées prises en charge, les montants doivent être opposés et les comptes distincts. Les indicateurs `grftt` 2 et 6 peuvent se présenter dans les deux sens. Le pointage est conservé séparément sur chaque écriture. Les deux comptes doivent être sélectionnés ensemble. [Modèle des virements documenté par Monize](https://github.com/kenlasko/monize/blob/main/docs/ms-money-data-model.md#trn_xfer-transfer-pairs)

`TRN_SPLIT` relie l’opération principale à ses parts, dans l’ordre `iSplit`. Les montants, catégories et commentaires proviennent des lignes `TRN` liées. La somme des parts doit correspondre au montant de l’écriture principale. Les ventilations contenant un virement interne sont refusées et les échéances ventilées sont signalées dans l’aperçu.

## Échéances

Les séries sont décrites dans `BILL` et reliées à leurs modèles dans `TRN`. Les valeurs `frq` et `cFrqInst` sont interprétées ensemble selon les configurations reconnues. Par exemple, pour `frq = 3`, `cFrqInst = 0,5` correspond au bimestriel et `cFrqInst = 2` au bimensuel. Le cas bimensuel pris en charge est un virement non commencé et sans limite, avec des occurrences le 15 et en fin de mois.

Pour les séries limitées reconnues, `cInstMax` et `dtMax` doivent être cohérents avec les dates projetées. La date de fin est inclusive. Pour les séries mensuelles de débit limitées et partiellement enregistrées prises en charge, la date d’origine et `iinstNextUnpaid` donnent la prochaine occurrence. Pour certaines séries sans limite, l’import déduit la date et le jour d’ancrage des versions disponibles et invite à les vérifier dans l’aperçu.

Les méthodes de paiement reposent sur des combinaisons de champs, dont `grfstem`, `grfEntryMethods` et `fPrint`, en tenant compte du sens de l’écriture. Une méthode inconnue est signalée dans l’aperçu. Les commentaires des modèles pris en charge sont repris lors de l’enregistrement des échéances.

## Références

Kresus importe `TRN.szId` dans le champ de référence. Le préfixe et le remplissage de la forme numérique reconnue sont retirés, en conservant les zéros qui appartiennent au numéro. La référence reste distincte du commentaire et du numéro de chèque, y compris pour chaque écriture d’un virement. [Modèle des opérations documenté par Monize](https://github.com/kenlasko/monize/blob/main/docs/ms-money-data-model.md#trn-all-transactions)
