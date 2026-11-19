# CRM Revendeurs — Les Imprimeuses

Outil interne pour suivre les revendeurs B2B : qui a commandé quoi, quand on leur a parlé pour la dernière fois, qui relancer. Réservé à l'équipe (Benjamin, Violette, Lauriane).

```
Shopify ──(chaque nuit, GitHub Actions)──▶ Supabase (base de données) ◀── Netlify (l'application web)
                                             comptes, commandes,           liste, fiches, journal,
                                             contacts, notes, relances      relances, export CSV
```

- **Comptes revendeurs** : les fiches Shopify sont regroupées par société, selon la règle du carnet (fiche entreprise B2B, sinon société de facturation ou de livraison, sinon e-mail). Les commandes Faire, Ankorstore et directes d'une même boutique se retrouvent ensemble.
- **Segment RFM** : recalculé chaque jour avec la règle du carnet (voir plus bas). Les seuils sont réglables dans la table `settings`.
- **Journal** : chaque appel, e-mail, visite ou salon est noté avec sa date et son auteur. La date du dernier contact en découle.
- **Relances** : un responsable, une date et une action par compte.
- **Listes** : listes toutes prêtes (« Champions sans contact depuis 60 j »…) et filtres combinables (segment, canal, pays, département, responsable, porte-clés, tags…). Chaque liste filtrée a sa propre adresse, à partager ou à mettre en favori, et peut être exportée en CSV.
- **Doublons** : un compte peut être fusionné dans un autre depuis sa fiche. Les commandes futures suivent.

Tout tourne sur des offres gratuites : Supabase Free, Netlify Free, GitHub Actions sur dépôt privé.

---

## Segmentation RFM

| Segment | Règle |
|---|---|
| **Champions** | Dernière commande il y a 90 jours ou moins, et CA HT cumulé ≥ 566 € |
| **Fidèles** | Dernière commande il y a 90 jours ou moins, sous 566 €, au moins 2 commandes |
| **Nouveaux** | Dernière commande il y a 90 jours ou moins, sous 566 €, une seule commande |
| **À relancer** | Dernière commande entre 91 et 365 jours, au moins 2 commandes |
| **Occasionnels** | Dernière commande entre 91 et 365 jours, une seule commande |
| **Inactifs** | Plus rien depuis plus de 365 jours |
| **Prospects** | Aucune commande de gros (fiche entreprise ou client tagué B2B sans commande, ou compte créé à la main) |

- **Commande de gros** : commande passée depuis le 01/02/2024, non annulée, avec un tag `b2b`, `Faire`, `Ankorstore` ou `Wholesale`, ou passée par une fiche entreprise Shopify (B2B natif).
- **Montant** : sous-total HT hors port (`currentSubtotalPriceSet`). On peut y ajouter des corrections manuelles, comme les 12 071 € de la Samaritaine, déjà enregistrés.
- **Porte-clés** : au moins une ligne dont le SKU commence par `POR-` ou `KC-`.
- **Canal** : le canal le plus utilisé du compte. L'avertissement « apporté par Faire » s'affiche quand la première commande est venue de Faire.
- **Exclusions** : comptes internes et de test (`sync/comptes.py`), adresses en `@lesimprimeuses.com`. Un compte peut aussi être masqué depuis sa fiche.

Le segment est calculé par la vue SQL `account_overview` à la date du jour. Les seuils se modifient dans Supabase > Table editor > `settings`.

---

## Installation (une seule fois, environ 45 minutes)

### 1. Supabase (la base de données)

1. Créer un compte sur <https://supabase.com>, puis **New project**. Nom : `crm-imprimeuses`. Région : *West EU (Paris)* ou *Central EU (Frankfurt)*. Choisir un mot de passe de base de données solide et le **garder** : il sert à l'étape 3.
2. Ouvrir **SQL Editor**, coller tout le contenu de [`supabase/migrations/001_schema.sql`](supabase/migrations/001_schema.sql) et cliquer sur **Run**.
3. Toujours dans le SQL Editor, déclarer l'équipe (adresses en minuscules) :
   ```sql
   insert into team_members (email, display_name) values
     ('benjamin@…', 'Benjamin'),
     ('violette@…', 'Violette'),
     ('lauriane@…', 'Lauriane');
   ```
4. **Authentication > Sign In / Providers** : désactiver **Allow new users to sign up**. Seules les personnes créées à la main pourront se connecter.
5. **Authentication > Users > Add user > Create new user** : pour chacune des 3 adresses, saisir un mot de passe provisoire et cocher **Auto Confirm User**. Chacune pourra changer son mot de passe en cliquant sur son prénom en haut à droite de l'application.
6. **Project Settings > API** (ou le bouton **Connect**) : noter l'**URL du projet** et la clé **anon** (ou *publishable*), pour l'étape 4.

> **Connexion par lien e-mail** (« mot de passe oublié ») : sans réglage, Supabase n'envoie d'e-mails qu'aux membres de l'organisation Supabase, avec un débit très limité. Pour que Violette et Lauriane puissent recevoir un lien, soit les inviter dans l'organisation Supabase, soit configurer un serveur d'envoi dans **Authentication > Emails > SMTP Settings** (Brevo ou Resend en gratuit, ou le SMTP de Google Workspace). La connexion par mot de passe, elle, fonctionne sans rien régler.

### 2. Shopify (l'accès en lecture aux commandes)

1. Dans l'admin Shopify : **Paramètres > Applications > Développer des applications**, qui renvoie vers le **Dev Dashboard** (<https://dev.shopify.com>). Créer une application, par exemple « CRM revendeurs ».
2. Dans la version de l'app, déclarer les accès (*scopes*) **`read_orders`**, **`read_all_orders`** et **`read_customers`**.
   - `read_all_orders` est indispensable : sans lui, l'API ne renvoie que les 60 derniers jours.
   - Pour une app de votre propre organisation, aucune validation de Shopify n'est nécessaire.
3. Publier la version, puis **installer l'app** sur la boutique `on-the-other-fish`.
4. Noter le **Client ID** et le **Client secret** (Settings de l'app).
5. Si, après la 1re synchro, les noms et e-mails des clients sont vides : dans le Dev Dashboard, activer l'accès aux **données client protégées** (nom, e-mail, téléphone, adresse) pour l'app.

> Si vous avez déjà une ancienne « app personnalisée » créée dans l'admin avec un jeton `shpat_…` ayant ces accès, vous pouvez utiliser ce jeton à la place (secret `SHOPIFY_ADMIN_TOKEN` ci-dessous).

### 3. GitHub (la synchro de chaque nuit)

Dans ce dépôt : **Settings > Secrets and variables > Actions > New repository secret**. Créer :

| Secret | Valeur |
|---|---|
| `SHOPIFY_SHOP` | `on-the-other-fish` |
| `SHOPIFY_CLIENT_ID` | le Client ID de l'étape 2 |
| `SHOPIFY_CLIENT_SECRET` | le Client secret de l'étape 2 |
| `DATABASE_URL` | Supabase > **Connect** > *Session pooler* > URI, avec le mot de passe de la base à la place de `[YOUR-PASSWORD]` |

Puis **Actions > Synchro Shopify > Run workflow** pour lancer une première synchro, qui prend quelques minutes. Elle tournera ensuite seule chaque nuit vers 4 h. En cas d'échec, GitHub envoie un e-mail. Le bandeau « Shopify : … » en haut de l'application indique la date de la dernière synchro réussie.

### 4. Netlify (l'application web)

1. Sur <https://app.netlify.com> : **Add new site > Import an existing project > GitHub**, choisir `crm-imprimeuses`. Les réglages de build sont lus dans `netlify.toml` : ne rien changer.
2. Avant de déployer, dans **Environment variables**, ajouter :
   - `VITE_SUPABASE_URL` = l'URL du projet Supabase
   - `VITE_SUPABASE_ANON_KEY` = la clé anon / publishable
3. **Deploy**. On peut renommer le site, par exemple `crm-imprimeuses.netlify.app`.
4. Dans Supabase > **Authentication > URL Configuration**, mettre l'adresse Netlify dans **Site URL**. C'est nécessaire pour les liens de connexion par e-mail.

La clé « anon » est publique par nature. Ce sont les règles de sécurité de la base (RLS) qui protègent les données : sans être connecté avec une adresse de `team_members`, on ne voit rien.

### 5. Vérifier

- Se connecter, puis compter les comptes : environ 340 au 19/09/2026, davantage aujourd'hui.
- Comparer quelques comptes connus avec le carnet `revendeurs-rfm-2026-09-01.csv`.
- Repérer les doublons restants (La Cachette de M / La Cachette M, Comme Les Grands / Comme Les Grands - Brest, OlivOlga, You & Me Paris, LPC / Enfin Lundi, La petite Nantaise…) et les **fusionner** depuis la fiche (bloc « Avancé »). C'est à faire une seule fois.

---

## Au quotidien

- **Après un appel ou un e-mail** : ouvrir la fiche, choisir le type et la date, écrire deux lignes, puis cliquer sur « Ajouter au journal ».
- **Planifier une relance** : bloc « Suivi », choisir le responsable, la date et l'action. Elle apparaît dans « Mes relances » et, une fois la date passée, dans « Relances en retard ».
- **Nouveau prospect, ou client présent seulement dans Pennylane** : « + Nouveau compte ». S'il commande ensuite sur Shopify sous le même nom de société, ses commandes arriveront dans ce compte.
- **Lancer une synchro immédiate** : GitHub > Actions > Synchro Shopify > Run workflow.

## Entretien

- **Version de l'API Shopify** (`sync/shopify.py`, `API_VERSION`) : à faire avancer environ une fois par an. Shopify maintient chaque version 12 mois.
- **Supabase Free** met en pause un projet inactif depuis 7 jours. La synchro quotidienne le maintient actif.
- **Tests** de la logique de regroupement : `pip install -r sync/requirements.txt pytest && python -m pytest sync/tests`. Ils tournent aussi automatiquement sur GitHub à chaque modification du dossier `sync/`.
- **Lancer la synchro sur son ordinateur** : définir les variables de l'étape 3, puis `python -m sync.main`. Ajouter `--dry-run` pour voir le résumé sans rien écrire.
- **L'interface en local** : `cd web && cp .env.example .env` (puis remplir), `npm install`, `npm run dev`.

## Organisation du code

| Dossier | Contenu |
|---|---|
| `supabase/migrations/` | Schéma de la base : tables, vue `account_overview` (RFM), fusion, règles d'accès |
| `sync/` | Synchro Shopify en Python : `comptes.py` (règles du carnet), `shopify.py` (API), `main.py` (orchestration) |
| `web/` | Application React (Vite) : `pages/AccountList.tsx`, `pages/AccountDetail.tsx`, `pages/NewAccount.tsx` |
| `.github/workflows/sync.yml` | Synchro de chaque nuit et tests |

## Prochaines étapes

1. **Carte des revendeurs dans le CRM** : géocodage pendant la synchro et vue carte derrière la connexion. Elle remplacera les cartes interne et mobile du `store-locator`, aujourd'hui publiques.
2. **Klaviyo et Pennylane** : import des prospects et des clients absents de Shopify.
3. **Carte publique** alimentée par le CRM : on pourra alors arrêter Matrixify, le Google Sheet et l'Apps Script.
