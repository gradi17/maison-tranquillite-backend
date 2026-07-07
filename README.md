# Mise en route — La maison de la tranquillité

Ce dossier contient le backend de paiement. Le site (fichier `boutique-bd.html`)
est séparé et s'héberge indépendamment. Voici toutes les étapes, dans l'ordre,
pour passer de la démo à un site réellement opérationnel.

## 1. Créer votre compte Stripe

1. Inscrivez-vous sur https://dashboard.stripe.com/register
2. Une fois connecté, restez en **mode test** pour l'instant (interrupteur en
   haut à droite du Dashboard).
3. Allez dans **Développeurs > Clés API** et copiez la clé secrète
   (`sk_test_...`) dans votre fichier `.env`.

## 2. Activer Apple Pay

1. Dans le Dashboard Stripe : **Paramètres > Moyens de paiement**, activez
   Apple Pay.
2. Stripe vous fournira un fichier de vérification de domaine
   (`apple-developer-merchantid-domain-association`). Téléchargez-le et
   déposez-le à l'adresse exacte `https://votredomaine.fr/.well-known/apple-developer-merchantid-domain-association`
   sur votre hébergement.
3. Apple Pay ne s'affiche que sur Safari (Mac/iPhone/iPad) et exige que le
   site soit servi en HTTPS — ce sera le cas automatiquement si vous suivez
   l'étape d'hébergement plus bas.

## 3. Activer PayPal

1. Toujours dans **Paramètres > Moyens de paiement**, activez PayPal.
2. Selon votre pays, Stripe peut vous demander une vérification
   supplémentaire de votre compte professionnel avant de l'activer en mode
   production (le mode test fonctionne sans attendre).

## 4. Installer et lancer le backend

```bash
cd backend
npm install
cp .env.example .env
# éditez .env avec vos vraies valeurs
npm start
```

Le serveur écoute par défaut sur `http://localhost:4000`.

## 5. Brancher le webhook (confirmation de paiement)

En local, pour tester :

```bash
stripe listen --forward-to localhost:4000/webhook/stripe
```

Cette commande (CLI Stripe, à installer une fois : https://stripe.com/docs/stripe-cli)
vous donne un `whsec_...` à mettre dans `.env`.

En production, dans le Dashboard Stripe : **Développeurs > Webhooks > Ajouter
un endpoint**, avec l'URL `https://votre-backend.com/webhook/stripe`, événement
`checkout.session.completed`. Le secret généré va aussi dans `.env`.

## 6. Envoyer les emails de livraison

Le fichier `server.js` contient une fonction `sendDownloadEmail()` avec un
exemple prêt à l'emploi utilisant [Resend](https://resend.com) (gratuit
jusqu'à 3000 emails/mois, simple à mettre en place). Créez un compte, récupérez
une clé API, décommentez le code correspondant, et remplacez les liens de
téléchargement factices par vos vrais liens (idéalement des liens signés et
expirants — un stockage comme Amazon S3 ou Cloudflare R2 sait générer ce
type de lien).

## 7. Connecter le frontend au backend

Dans `boutique-bd.html`, la fonction `completeOrder()` simule actuellement le
paiement. Remplacez son contenu par un appel réel :

```javascript
async function goToCheckout(){
  const itemIds = cart.map(b => b.id);
  const response = await fetch('https://votre-backend.com/api/checkout', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ itemIds })
  });
  const data = await response.json();
  window.location.href = data.url; // redirige vers la page de paiement Stripe
}
```

Stripe affichera alors sa page de paiement hébergée, avec carte, Apple Pay et
PayPal proposés automatiquement selon l'appareil du client.

## 8. Héberger le tout

- **Le site (fichier HTML)** : Netlify ou Vercel (glisser-déposer le fichier,
  gratuit, HTTPS automatique — indispensable pour Apple Pay).
- **Le backend (dossier `backend/`)** : Render, Railway ou Fly.io — ce sont
  des hébergeurs gratuits ou peu chers pour ce type de petit serveur Node.js.
  Déployez-le, notez son URL, et reportez-la dans `FRONTEND_URL` (backend) et
  dans l'appel `fetch` (frontend).
- **Nom de domaine** : achetez-en un (OVH, Gandi...) et pointez-le vers votre
  hébergement Netlify/Vercel.

## 9. Tester avant de passer en réel

Tant que vous utilisez les clés `sk_test_...`, aucune vraie carte n'est
débitée. Stripe fournit des numéros de test (`4242 4242 4242 4242`, n'importe
quelle date future, n'importe quel CVC) et un simulateur Apple Pay/PayPal en
mode sandbox. Testez tout le parcours : ajout au panier, paiement, réception
de l'email, avant de basculer sur les clés `sk_live_...`.

## 10. Passer en production

1. Dans Stripe, basculez le Dashboard en mode production.
2. Remplacez `sk_test_...` par `sk_live_...` dans `.env` sur votre serveur
   déployé (jamais dans le code).
3. Recréez le webhook en mode production (les secrets test et production
   sont différents).
4. Vérifiez que votre domaine est bien en HTTPS partout.

À partir de là, le site est opérationnel : les clients paient par carte,
Apple Pay ou PayPal en ne fournissant qu'un email, et reçoivent leurs BD
numériques automatiquement.
