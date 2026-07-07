// Serveur de paiement — La maison de la tranquillité
//
// Ce serveur gère la création des paiements (carte, Apple Pay, PayPal)
// via Stripe, et reçoit la confirmation de paiement via un webhook pour
// déclencher l'envoi de l'email contenant les liens de téléchargement.
//
// Pourquoi tout passer par Stripe : Stripe gère nativement Apple Pay
// (dès que votre domaine est vérifié) et PayPal comme moyen de paiement,
// en plus de la carte bancaire — un seul intégrateur, une seule facture
// de commission, un seul webhook à gérer. C'est l'option recommandée ici.
// (Une intégration PayPal "en direct", via le SDK PayPal, reste possible
// si vous préférez — voir la note en bas de fichier.)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors());

// Le webhook Stripe a besoin du corps brut de la requête (pas du JSON
// parsé) pour vérifier la signature — on le déclare donc AVANT
// express.json(), avec son propre middleware.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details && session.customer_details.email;
    const sessionId = session.id;

    try {
      // On récupère le détail des articles achetés pour savoir
      // quels fichiers envoyer.
      const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);
      await sendDownloadEmail(email, lineItems.data);
      console.log(`Paiement confirmé pour ${email}, email de livraison envoyé.`);
    } catch (err) {
      console.error('Erreur lors de la livraison après paiement:', err);
    }
  }

  res.json({ received: true });
});

app.use(express.json());

// Catalogue côté serveur — NE JAMAIS faire confiance aux prix envoyés
// par le navigateur. On revérifie toujours le prix ici avant de créer
// la session de paiement.
const CATALOG = {
  1: { title: 'Les Ombres de Verre', price: 690 },
  2: { title: 'Rouille & Néon', price: 750 },
  3: { title: 'Le Cirque Muet', price: 590 },
  4: { title: "Chasseurs d'Orage", price: 820 },
  5: { title: 'Pixel Requiem', price: 650 },
  6: { title: 'La Dernière Marée', price: 550 },
  7: { title: "Griffes d'Encre", price: 790 },
  8: { title: 'Radio Silence', price: 690 },
  9: { title: 'Sous le Métro Gris', price: 590 },
  // prix en centimes
};

// Crée une session de paiement Stripe. Le frontend appelle cette route
// avec la liste des ids du panier, puis redirige l'utilisateur vers
// l'URL renvoyée (session.url) — Stripe affiche alors une page de
// paiement hébergée qui propose automatiquement carte, Apple Pay (si le
// domaine est vérifié et l'appareil compatible) et PayPal.
app.post('/api/checkout', async (req, res) => {
  try {
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'Panier vide ou invalide.' });
    }

    const line_items = itemIds.map((id) => {
      const product = CATALOG[id];
      if (!product) throw new Error(`Produit inconnu: ${id}`);
      return {
        price_data: {
          currency: 'eur',
          product_data: { name: product.title },
          unit_amount: product.price,
        },
        quantity: 1,
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'paypal'],
      line_items,
      // Stripe ajoute Apple Pay / Google Pay automatiquement au moyen
      // de paiement "card" dès qu'ils sont activés dans le Dashboard.
      success_url: `${process.env.FRONTEND_URL}/merci?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/panier`,
      // On ne demande que l'email, jamais l'adresse postale, puisqu'il
      // n'y a rien à expédier.
      billing_address_collection: 'auto',
      metadata: { itemIds: itemIds.join(',') },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Fonction à compléter : c'est ici que vous branchez votre service
// d'envoi d'email (Resend, Postmark, SendGrid...) pour livrer les
// fichiers. Voir le README pour un exemple avec Resend.
async function sendDownloadEmail(email, lineItems) {
  if (!email) {
    console.warn('Aucun email trouvé sur la session, impossible de livrer.');
    return;
  }
  console.log(`[À implémenter] Envoyer à ${email} les liens pour :`,
    lineItems.map((li) => li.description).join(', '));

  // Exemple avec Resend (à décommenter une fois la clé API configurée) :
  //
  // const { Resend } = require('resend');
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from: 'La maison de la tranquillité <commandes@votredomaine.fr>',
  //   to: email,
  //   subject: 'Vos BD numériques sont prêtes',
  //   html: buildDownloadEmailHtml(lineItems),
  // });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Serveur de paiement lancé sur le port ${PORT}`));

// ---------------------------------------------------------------------
// Alternative : intégrer PayPal séparément (bouton PayPal natif) plutôt
// que via Stripe. Utile si vous voulez un vrai bouton PayPal officiel
// distinct, ou des règlements PayPal séparés de vos règlements Stripe.
// Grandes lignes (nécessite le SDK PayPal côté frontend + ces 2 routes) :
//
// app.post('/api/paypal/create-order', async (req, res) => {
//   // Appeler POST https://api-m.paypal.com/v2/checkout/orders
//   // avec un jeton obtenu via /v1/oauth2/token (client_id + secret)
// });
// app.post('/api/paypal/capture-order', async (req, res) => {
//   // Appeler POST https://api-m.paypal.com/v2/checkout/orders/{id}/capture
//   // puis déclencher sendDownloadEmail() comme ci-dessus
// });
