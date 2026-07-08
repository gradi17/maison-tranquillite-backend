// Serveur — La maison de la tranquillité
//
// Ce serveur fait 3 choses :
// 1. Gère le catalogue de livres (stocké dans books.json) et l'expose
//    via /api/books pour que la boutique l'affiche toujours à jour.
// 2. Fournit un panneau d'administration (/admin) protégé par un mot de
//    passe, pour ajouter/modifier/supprimer un livre sans jamais toucher
//    à GitHub ni Netlify.
// 3. Gère le paiement (Stripe : carte, Apple Pay, PayPal...) et l'envoi
//    automatique de l'email de livraison avec le PDF en pièce jointe.
//
// IMPORTANT — sauvegardes : books.json et les PDF vivent sur le disque
// du serveur Render. Ils survivent aux redémarrages normaux, mais un
// futur déploiement de code depuis GitHub réinitialise ce disque.
// Utilisez le bouton "Exporter une sauvegarde" du panneau admin de temps
// en temps, et prévenez-moi avant qu'on redéploie du code à l'avenir.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads-tmp') });

const BOOKS_FILE = path.join(__dirname, 'books.json');
const FILES_DIR = path.join(__dirname, 'files');       // PDF — jamais servis publiquement
const IMAGES_DIR = path.join(__dirname, 'images');     // couvertures/aperçus — servis publiquement
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

function fileExtension(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return ext || '.jpg';
}

// Catalogue de départ, pour ne rien perdre de ce qu'on a déjà construit.
// Ce fichier ne sera utilisé que si books.json n'existe pas encore.
const SEED_BOOKS = [
  { id: 1, title: "Les Ombres de Verre", author: "L. Faucher", category: "Fantastique", price: 6.90, color: "#8FA9B8", tags: ["noir et blanc", "magie", "one-shot"], mature: false, file: null, cover: null, previews: [] },
  { id: 2, title: "Rouille & Néon", author: "K. Adamo", category: "Science-fiction", price: 7.50, color: "#7C97A3", tags: ["cyberpunk", "couleur", "tome 1"], mature: false, file: null, cover: null, previews: [] },
  { id: 3, title: "Le Cirque Muet", author: "P. Rennes", category: "Drame", price: 5.90, color: "#A3937E", tags: ["noir et blanc", "one-shot", "adulte"], mature: false, file: null, cover: null, previews: [] },
  { id: 4, title: "Chasseurs d'Orage", author: "M. Ilva", category: "Aventure", price: 8.20, color: "#7FA68F", tags: ["couleur", "young adult", "tome 1"], mature: false, file: null, cover: null, previews: [] },
  { id: 5, title: "Pixel Requiem", author: "S. Doko", category: "Science-fiction", price: 6.50, color: "#8FA9B8", tags: ["cyberpunk", "post-apocalyptique", "couleur"], mature: false, file: null, cover: null, previews: [] },
  { id: 6, title: "La Dernière Marée", author: "A. Costa", category: "Drame", price: 5.50, color: "#A3937E", tags: ["noir et blanc", "adulte", "one-shot"], mature: false, file: null, cover: null, previews: [] },
  { id: 7, title: "Griffes d'Encre", author: "J. Brahn", category: "Fantastique", price: 7.90, color: "#9C8FA6", tags: ["magie", "couleur", "young adult"], mature: false, file: null, cover: null, previews: [] },
  { id: 8, title: "Radio Silence", author: "T. Onwe", category: "Aventure", price: 6.90, color: "#7FA68F", tags: ["post-apocalyptique", "noir et blanc", "tome 1"], mature: false, file: null, cover: null, previews: [] },
  { id: 9, title: "Sous le Métro Gris", author: "F. Lemn", category: "Drame", price: 5.90, color: "#7C97A3", tags: ["adulte", "couleur", "one-shot"], mature: false, file: null, cover: null, previews: [] },
  { id: 10, title: "L'entraînement de la nuit", author: "Kotaro", category: "Aventure", price: 6.50, color: "#A98CA0", tags: ["sexe", "adulte", "hentai", "amour", "bonheur", "manga", "aventure", "numberone", "decouverte", "bd erotique"], mature: true, file: "entrainement-de-la-nuit.pdf", cover: null, previews: [] },
];

function loadBooks() {
  if (!fs.existsSync(BOOKS_FILE)) {
    fs.writeFileSync(BOOKS_FILE, JSON.stringify(SEED_BOOKS, null, 2));
  }
  return JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf-8'));
}

function saveBooks(books) {
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(books, null, 2));
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Vérifie le mot de passe admin, envoyé dans l'en-tête "x-admin-key".
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Mot de passe admin invalide.' });
  }
  next();
}

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

    try {
      const itemIds = (session.metadata && session.metadata.itemIds)
        ? session.metadata.itemIds.split(',')
        : [];
      await sendDownloadEmail(email, itemIds);
      console.log(`Paiement confirmé pour ${email}, email de livraison envoyé.`);
    } catch (err) {
      console.error('Erreur lors de la livraison après paiement:', err);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(IMAGES_DIR));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/admin');
});

// ---------------------------------------------------------------------
// API PUBLIQUE — utilisée par la boutique pour afficher le catalogue
// ---------------------------------------------------------------------

app.get('/api/books', (req, res) => {
  const books = loadBooks().map(({ file, ...rest }) => rest); // ne jamais exposer le nom de fichier au public
  res.json(books);
});

// ---------------------------------------------------------------------
// API ADMIN — protégée par mot de passe, utilisée par /admin
// ---------------------------------------------------------------------

app.get('/api/admin/books', requireAdmin, (req, res) => {
  res.json(loadBooks());
});

const bookUpload = upload.fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
  { name: 'previews', maxCount: 6 },
]);

app.post('/api/admin/books', requireAdmin, bookUpload, (req, res) => {
  const books = loadBooks();
  const { title, author, category, price, tags, mature, color } = req.body;

  if (!title || !price) {
    return res.status(400).json({ error: 'Titre et prix sont obligatoires.' });
  }

  const newId = books.length > 0 ? Math.max(...books.map(b => b.id)) + 1 : 1;
  const files = req.files || {};

  let fileName = null;
  if (files.pdf && files.pdf[0]) {
    fileName = `${newId}-${slugify(title)}.pdf`;
    fs.renameSync(files.pdf[0].path, path.join(FILES_DIR, fileName));
  }

  let coverName = null;
  if (files.cover && files.cover[0]) {
    coverName = `${newId}-cover${fileExtension(files.cover[0].originalname)}`;
    fs.renameSync(files.cover[0].path, path.join(IMAGES_DIR, coverName));
  }

  const previewNames = (files.previews || []).map((f, i) => {
    const name = `${newId}-preview-${i + 1}${fileExtension(f.originalname)}`;
    fs.renameSync(f.path, path.join(IMAGES_DIR, name));
    return name;
  });

  const newBook = {
    id: newId,
    title,
    author: author || '',
    category: category || 'Autre',
    price: parseFloat(price),
    color: color || '#8FA9B8',
    tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    mature: mature === 'true' || mature === true,
    file: fileName,
    cover: coverName,
    previews: previewNames,
  };

  books.push(newBook);
  saveBooks(books);
  res.json(newBook);
});

app.put('/api/admin/books/:id', requireAdmin, bookUpload, (req, res) => {
  const books = loadBooks();
  const id = parseInt(req.params.id, 10);
  const book = books.find(b => b.id === id);

  if (!book) return res.status(404).json({ error: 'Livre introuvable.' });

  const { title, author, category, price, tags, mature, color } = req.body;
  if (title) book.title = title;
  if (author !== undefined) book.author = author;
  if (category) book.category = category;
  if (price) book.price = parseFloat(price);
  if (color) book.color = color;
  if (tags !== undefined) book.tags = tags.split(',').map(t => t.trim()).filter(Boolean);
  if (mature !== undefined) book.mature = mature === 'true' || mature === true;

  const files = req.files || {};

  if (files.pdf && files.pdf[0]) {
    const fileName = `${id}-${slugify(book.title)}.pdf`;
    fs.renameSync(files.pdf[0].path, path.join(FILES_DIR, fileName));
    book.file = fileName;
  }

  if (files.cover && files.cover[0]) {
    if (book.cover) {
      const oldPath = path.join(IMAGES_DIR, book.cover);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const coverName = `${id}-cover${fileExtension(files.cover[0].originalname)}`;
    fs.renameSync(files.cover[0].path, path.join(IMAGES_DIR, coverName));
    book.cover = coverName;
  }

  if (files.previews && files.previews.length > 0) {
    (book.previews || []).forEach((p) => {
      const oldPath = path.join(IMAGES_DIR, p);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    });
    book.previews = files.previews.map((f, i) => {
      const name = `${id}-preview-${i + 1}${fileExtension(f.originalname)}`;
      fs.renameSync(f.path, path.join(IMAGES_DIR, name));
      return name;
    });
  }

  saveBooks(books);
  res.json(book);
});

app.delete('/api/admin/books/:id', requireAdmin, (req, res) => {
  const books = loadBooks();
  const id = parseInt(req.params.id, 10);
  const book = books.find(b => b.id === id);

  if (book) {
    if (book.file) {
      const filePath = path.join(FILES_DIR, book.file);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (book.cover) {
      const coverPath = path.join(IMAGES_DIR, book.cover);
      if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    }
    (book.previews || []).forEach((p) => {
      const previewPath = path.join(IMAGES_DIR, p);
      if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
    });
  }

  const filtered = books.filter(b => b.id !== id);
  saveBooks(filtered);
  res.json({ deleted: id });
});

// Sauvegarde téléchargeable du catalogue complet (sans les PDF).
app.get('/api/admin/export', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="books-backup.json"');
  res.json(loadBooks());
});

// ---------------------------------------------------------------------
// PAIEMENT
// ---------------------------------------------------------------------

app.post('/api/checkout', async (req, res) => {
  try {
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'Panier vide ou invalide.' });
    }

    const books = loadBooks();

    const line_items = itemIds.map((id) => {
      const product = books.find(b => b.id === parseInt(id, 10));
      if (!product) throw new Error(`Produit inconnu: ${id}`);
      return {
        price_data: {
          currency: 'eur',
          product_data: { name: product.title },
          unit_amount: Math.round(product.price * 100),
        },
        quantity: 1,
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // On ne précise volontairement aucun "payment_method_types" ici :
      // les Checkout Sessions Stripe affichent automatiquement, tout
      // seules, tous les moyens de paiement que vous avez activés et
      // rendus éligibles dans votre Dashboard (carte, Apple Pay, PayPal,
      // Klarna, Scalapay...).
      line_items,
      success_url: `${process.env.FRONTEND_URL}/?paid=true`,
      cancel_url: `${process.env.FRONTEND_URL}/panier`,
      billing_address_collection: 'auto',
      metadata: { itemIds: itemIds.join(',') },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Envoie l'email de livraison avec les PDF en pièce jointe, via Resend.
async function sendDownloadEmail(email, itemIds) {
  if (!email) {
    console.warn('Aucun email trouvé sur la session, impossible de livrer.');
    return;
  }

  const books = loadBooks();
  const products = itemIds
    .map((id) => books.find(b => b.id === parseInt(id, 10)))
    .filter(Boolean);

  const attachments = [];
  const itemsListHtml = [];

  for (const product of products) {
    if (product.file) {
      const filePath = path.join(FILES_DIR, product.file);
      try {
        const fileBuffer = fs.readFileSync(filePath);
        attachments.push({
          filename: product.file,
          content: fileBuffer.toString('base64'),
        });
        itemsListHtml.push(`<li>${product.title} — en pièce jointe à cet email</li>`);
      } catch (err) {
        console.error(`Fichier introuvable pour ${product.title}:`, err.message);
        itemsListHtml.push(`<li>${product.title} — indisponible pour le moment, contactez-nous</li>`);
      }
    } else {
      itemsListHtml.push(`<li>${product.title} — fichier bientôt disponible, nous vous recontactons</li>`);
    }
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'La maison de la tranquillité <commandes@lamaisondelatranquillite.com>',
      to: email,
      subject: 'Vos BD numériques sont prêtes',
      html: `
        <p>Merci pour votre commande !</p>
        <p>Voici le détail :</p>
        <ul>${itemsListHtml.join('')}</ul>
        <p>Bonne lecture,<br>La maison de la tranquillité</p>
      `,
      attachments,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Erreur Resend:', errorText);
    throw new Error('Échec de l\'envoi de l\'email de livraison.');
  }

  console.log(`Email de livraison envoyé à ${email} (${attachments.length} pièce(s) jointe(s)).`);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
