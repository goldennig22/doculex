# Séance de relecture DocuLex : décisions de la CCJA

Merci de nous aider ! DocuLex publie des décisions de justice OHADA, **anonymisées** et reliées aux articles des Actes uniformes qu'elles citent. Une machine a fait un premier jet. Votre relecture est la seule étape humaine avant que la décision soit publique : si vous publiez, c'est vous qui en répondez.

Durée : 3 h. Objectif réaliste : 10 à 12 décisions chacun (de 12 à 20 min par décision une fois la première faite).

---

## Avant de commencer

- [ ] J'ai signé l'engagement de confidentialité (une page). Pendant la relecture, je vois les **noms en clair** des parties. Je ne les copie nulle part : ni dans le tableau, ni dans mes notes, ni dans une photo d'écran.
- [ ] J'ai ma clé « relecteur » (`dlx_…`) à mon nom. Elle sera **révoquée à la fin de la séance**.
- [ ] J'ouvre la page de relecture **`/review`** et j'y colle ma clé. La file s'affiche : décisions signalées en premier, puis les plus anciennes. Un clic ouvre une décision avec ses métadonnées, ses noms (en clair tant qu'ils ne sont pas confirmés), ses articles cités et son texte intégral, où les noms remplacés sont surlignés.
- [ ] Les corrections et la publication passent par `/docs` (Swagger), avec la même clé : `PATCH /api/decisions/:id`, puis `POST /api/decisions/:id/publish`. Les `id` à copier sont dans la page de relecture.
- [ ] Je ne relis jamais une décision que j'ai moi-même téléversée (l'API refuse de toute façon : 403).
- [ ] J'ai le tableau de suivi ouvert (`eval/review-tally.csv`) et je remplis **une ligne par décision**, au fur et à mesure.

---

## La liste, pour chaque décision

Lisez la décision en entier : toutes les sections, du « Faits » au dispositif, pas seulement les noms signalés.

### 1. Métadonnées

| Champ | Ce qu'on vérifie | Piège fréquent |
| --- | --- | --- |
| Juridiction | « CCJA », ou le nom exact de la juridiction nationale | — |
| Chambre | « Première chambre », « Deuxième chambre », etc. | Vide si la décision ne l'indique pas : c'est correct |
| Numéro | Tel qu'imprimé : « Arrêt n° 096/2015 » | Le numéro du **pourvoi** n'est pas celui de l'arrêt |
| Date | La date de l'**arrêt** | La date du pourvoi ou de la décision attaquée ; `10/05/2016` = **10 mai** |
| Pays | Code à deux lettres (CM, CI, SN…) de la juridiction | **Toujours vide pour la CCJA** |
| Matière | Quelques mots : « saisie-attribution », « bail commercial » | Trop vague (« droit des affaires ») |
| Solution | cassation, rejet, irrecevabilité… | Lire le **dernier** « PAR CES MOTIFS » : les précédents citent la juridiction d'appel |

Dans le tableau, pour chaque champ : `ok`, `F` (faux, corrigé), `M` (manquant, ajouté) ou `I` (inventé : rempli alors que la décision ne le dit pas, supprimé).

### 2. Anonymisation : chaque nom

**On anonymise** les personnes physiques : les parties, leurs avocats, les notaires, les huissiers, les témoins, et le commerçant qui se cache derrière « Établissements KAMGA ».
**On garde** les sociétés (SA, SARL, SCI…), l'État et ses administrations, les juridictions, les magistrats et greffiers qui siègent dans l'affaire.

- [ ] Pour chaque nom signalé : **confirmer** (c'est une personne), **pas une personne** (une société, un juge qui siège), ou **réattribuer** (deux personnes ont reçu la même lettre, ou une personne en a deux).
- [ ] Je cherche les noms **oubliés**, surtout sans titre (« TCHOUPO, émancipé… »), dans les citations et dans le dispositif. Je les ajoute (`addMentions`).
- [ ] Je vérifie que « M. X » désigne la même personne partout dans la décision.
- [ ] **Identifiants indirects** (adresse, numéro de compte, de titre foncier ou de téléphone, « le seul pharmacien de Bafang ») : je **ne corrige pas** moi-même. Je le signale dans la colonne `indirect` et je laisse la décision en relecture.

Dans le tableau : le nombre de noms signalés par la machine, combien étaient **oubliés** (ajoutés par moi) et combien étaient **cachés à tort** (« pas une personne »).

### 3. Le résumé (chapeau)

- [ ] Il dit **ce que la Cour a jugé** et pourquoi, pas ce que soutenait la partie qui a perdu. C'est l'erreur la plus fréquente : le moyen présenté comme la solution.
- [ ] Il ne contient aucun nom de personne physique.
- [ ] Trois phrases au plus, dans la langue de la décision.

Dans le tableau : `ok`, `corrigé` (une phrase changée) ou `réécrit`.

### 4. Les articles cités

- [ ] Chaque article cité par la décision est relié au bon Acte uniforme (AUDCG, AUSCGIE, AUPSRVE…).
- [ ] Et à la bonne **version** : l'AUDCG de 1997 ou celui de 2010, selon la date des faits. Les numéros d'articles ont changé.
- [ ] Je note les citations oubliées et les liens faux. Ils se lisent dans la section « Articles cités » de la page de relecture. Ils ne se corrigent pas encore par l'API : je les note seulement.

Dans le tableau : le nombre de citations, de liens faux et de liens manquants.

### 5. Décider

- **Publier** si les points 1 à 4 sont bons. Si l'API refuse (409), elle dit pourquoi : un nom non confirmé, un nom encore présent dans le titre ou le résumé, etc.
- **Laisser en relecture** si vous avez un doute (identifiant indirect, texte illisible). Notez pourquoi.
- **Rejeter** si ce n'est pas une décision exploitable (texte tronqué, scan illisible, doublon).

---

## Déroulé de la séance

| Heure | Quoi |
| --- | --- |
| 0:00 – 0:25 | Présentation, engagement signé, clés remises. **Une décision ensemble, à l'écran** (arrêt n° 096/2015). |
| 0:25 – 1:25 | Relecture individuelle. |
| 1:25 – 1:35 | Pause. Questions et cas douteux mis en commun. |
| 1:35 – 2:40 | Relecture individuelle. **Une décision sur cinq** est relue par l'autre personne, **sans voir** la première ligne du tableau. |
| 2:40 – 3:00 | On compare les doubles relectures, on termine le tableau, les clés sont révoquées (`npm run keys:revoke -- --label "relecteur-1"`). |
