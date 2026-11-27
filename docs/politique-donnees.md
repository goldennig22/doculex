# DocuLex : politique des données et d'anonymisation

*Projet, version du 27 novembre 2026, soumis à relecture juridique avant la mise en ligne des décisions.*

DocuLex est un outil de recherche gratuit sur le droit OHADA. Il publie les Actes uniformes et des décisions de justice (CCJA et juridictions nationales), reliées aux articles qu'elles citent. **Ce n'est pas un conseil juridique.**

## 1. D'où viennent les décisions

- De sources publiques : la base Ohadata, le greffe de la CCJA, des recueils publiés. Chaque décision garde le nom de sa source et, s'il existe, le lien vers l'original.
- Les résumés publiés sur DocuLex sont rédigés pour DocuLex (premier jet par un modèle de langage, puis relu). DocuLex ne reprend pas les commentaires, notes ou sommaires d'éditeurs.

## 2. Ce qui est anonymisé, et ce qui ne l'est pas

| Anonymisé (remplacé par « M. X », « Dame Y »…) | Laissé en clair |
| --- | --- |
| Les personnes physiques parties au procès | Les sociétés et autres personnes morales |
| Leurs avocats, notaires et huissiers ; les témoins | L'État, ses administrations, les établissements publics |
| Le commerçant derrière une enseigne sans personnalité juridique (« Établissements KAMGA ») | Les juridictions, ainsi que les magistrats et greffiers qui siègent dans l'affaire |

Une même personne porte la même lettre partout dans une décision, et une lettre différente d'une décision à l'autre.

**Ce qui n'est pas traité automatiquement :** les identifiants indirects (adresse, numéro de titre foncier ou de compte, description qui ne vise qu'une personne). Le relecteur les signale, et la décision reste non publiée jusqu'à ce qu'ils soient traités.

## 3. Comment : une machine, puis une personne

1. **Détection** : des règles (titres comme « M. », « Maître », « le sieur ») puis un modèle de langage listent les noms. Chaque nom est remplacé dans le texte dès la détection.
2. **Relecture humaine obligatoire** : un relecteur (un étudiant en droit ou moi-même, jamais la personne qui a ajouté la décision) lit le texte entier, confirme ou corrige chaque nom et ajoute ceux qui ont été oubliés.
3. **Blocages techniques à la publication** : la base de données refuse de publier une décision tant qu'un nom n'est pas confirmé. Avant publication, une vérification recherche chaque nom remplacé dans le titre, le résumé, la matière et tout le texte. L'en-tête de la décision (qui liste les parties) est effacé à la publication.

## 4. Où passent les noms en clair, et combien de temps

- **Dans la base, pendant la relecture seulement.** Le nom en clair d'une mention est effacé dès qu'un relecteur la confirme. Il ne reste alors qu'une empreinte chiffrée (HMAC avec une clé secrète, propre à chaque décision) qui sert à vérifier qu'aucun nom ne réapparaît. Elle ne permet pas de relier une même personne entre deux décisions.
- **Chez des prestataires d'intelligence artificielle, hors du Cameroun.** Pour extraire les métadonnées, détecter les noms et calculer l'index de recherche, le texte de la décision est envoyé, **avant anonymisation**, à des modèles hébergés par Anthropic, OpenAI ou Google (États-Unis). *Voir la question 1 ci-dessous.*
- **Dans le fichier source** : le PDF d'origine, conservé hors de la base et hors du dépôt de code.
- **Relecteurs** : ils voient les noms en clair. Chacun a une clé personnelle, révoquée à la fin de la séance, et signe un engagement de confidentialité.

## 5. Signaler une décision : retrait immédiat

Chaque décision publiée porte un formulaire « Signaler un problème » (sur la page d'accueil, ou `POST /api/decisions/:id/report`). Il permet de dire qu'un nom ou un détail identifiant apparaît, ou qu'une information est fausse. Aucun compte n'est demandé.

- Un signalement pour **données personnelles** retire la décision **immédiatement**, sans attendre de vérification. Elle redevient invisible dans toutes les recherches, et je suis prévenu aussitôt.
- Garde-fou contre les abus : au-delà de 5 retraits automatiques en 24 heures, les signalements sont enregistrés et me sont transmis, mais c'est moi qui décide du retrait. Un même accès Internet ne peut envoyer que 5 signalements par heure.
- Elle est relue, corrigée puis republiée, ou supprimée, sous **[N] jours**.
- Le message du signalement et l'adresse de contact (facultative) sont conservés **[N] mois** après traitement, puis effacés. Ils ne sont jamais publiés et ne sont pas transmis à un service tiers.

## 6. Questions posées à l'assistant

Les questions posées à `/ask` sont enregistrées (texte, coût, temps de réponse) pour mesurer la qualité du service. Une question peut contenir un nom : elles sont conservées **[N] mois**.

## 7. Vos droits

Toute personne qui se reconnaît dans une décision peut demander le retrait d'un passage ou de la décision entière à **[adresse]**, en plus du bouton de signalement. Base légale invoquée : **[à confirmer, voir la question 2]**.

---

## Questions pour la relecture juridique

1. **Transfert hors du Cameroun.** Les décisions non anonymisées sont envoyées à des prestataires américains (modèles de langage, calcul d'index). Au regard de la loi n° 2024/017 relative à la protection des données à caractère personnel, est-ce admissible ? Faut-il un accord avec ces prestataires, ou anonymiser par règles seules avant tout envoi ?
2. **Base légale.** Intérêt légitime (diffusion de la jurisprudence) ou autre ? Une déclaration ou une autorisation est-elle requise auprès de l'autorité de protection ?
3. **Lien vers la source.** Chaque décision renvoie à l'original (par exemple Ohadata), qui peut contenir les noms en clair. Est-ce un problème, puisque DocuLex aurait alors anonymisé une décision tout en renvoyant à sa version nominative ?
4. **Périmètre.** Faut-il aussi anonymiser les magistrats, ou les avocats (actuellement anonymisés) peuvent-ils rester nommés ?
5. **Droit d'auteur.** Les décisions elles-mêmes sont-elles librement réutilisables ? Et les textes tels que mis en forme par Ohadata ?
6. **Délais.** Quels délais raisonnables pour traiter un signalement et pour conserver les signalements et les questions ?
