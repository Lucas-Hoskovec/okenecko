# Okénečko

Carnet de chansons personnelles, moderne, épuré et 100 % local.

Écrivez vos propres paroles, ouvrez une chanson : elle s'affiche en grand sur fond noir et défile automatiquement pendant que vous jouez de la guitare. Lecture / pause et vitesse − / + se contrôlent avec de gros boutons.

- Deux onglets seulement : **Accueil** et **Réglages**
- PWA installable sur Android et iPhone, utilisable **hors ligne**
- Données dans **IndexedDB** sur l'appareil uniquement (aucun serveur, aucun compte)
- Recherche, favoris, épinglage
- **Dictée des paroles** au micro dans l'éditeur (Web Speech API, français)
- Le menu **⋯** de chaque chanson contient : épingler, favori, exporter en PDF, exporter en texte, sauvegarder **cette chanson** en JSON, supprimer
- La sauvegarde de **tout le catalogue** se fait depuis les réglages
- Sauvegarde automatique dans un dossier sur Android (File System Access API)

---

## 1. Lancer en local

Aucune dépendance. Depuis ce dossier :

```powershell
py -m http.server 8000
```

Ouvrez `http://localhost:8000` dans Chrome/Edge.

> Le micro n'étant plus utilisé, le HTTPS n'est nécessaire que pour l'installation PWA et le fonctionnement hors-ligne. `localhost` suffit pour tester.

## 2. Déployer (pour installer sur un téléphone)

Hébergez les fichiers statiques sur un service HTTPS gratuit :

- **Netlify** : glissez le dossier `okenechko` sur https://app.netlify.com/drop
- **Cloudflare Pages** : *Create a project* → *Direct Upload* → sélectionnez le dossier
- **Vercel** : `npx vercel --prod` depuis le dossier
- **GitHub Pages** : publiez le dossier puis activez *Pages*

Envoyez ensuite le lien HTTPS au téléphone concerné.

> Après une mise à jour des fichiers, incrémentez `CACHE_NAME` dans `sw.js` (ex. `okenechko-v5` → `okenechko-v6`) pour que le service worker remplace son cache.

## 3. Installer sur Android (Chrome)

1. Ouvrez le lien HTTPS dans **Chrome**.
2. Menu **⋮** → **« Installer l'application »**.
3. Confirmez : l'icône **Okénečko** apparaît sur l'écran d'accueil.

Le bouton **Installer Okénečko** existe aussi dans **Réglages**.

## 4. Installer sur iPhone (Safari)

1. Ouvrez le lien dans **Safari**.
2. Bouton **Partager** → **« Sur l'écran d'accueil »** → **« Ajouter »**.

Les étapes sont rappelées dans **Réglages**.

## 5. Utilisation

- **+** : écrire une chanson (titre, artiste facultatif, paroles). Dans le champ Paroles, le bouton **Dicter** lance la reconnaissance vocale : parlez, le texte s'écrit en direct ; **Arrêter** termine la dictée.
- Appuyez sur une chanson : elle s'ouvre en grand et le défilement se contrôle avec lecture/pause et vitesse − / +.
- Bouton **⋯** d'une chanson : épingler, ajouter/retirer des favoris, exporter en PDF ou en texte, **sauvegarder cette chanson** en JSON, supprimer.
- **Réglages** : installer l'appli, restaurer une sauvegarde, activer le dossier de sauvegarde automatique (Android), et ouvrir le **guide d'utilisation** qui présente toutes les fonctions.

## 6. Sauvegarde et données

Les chansons vivent dans le stockage local du navigateur (IndexedDB), rattaché à l'adresse HTTPS de l'appli. Elles ne partent jamais sur un serveur.

- La **sauvegarde du catalogue** (toutes les chansons) se crée dans **Réglages**. Le menu ⋯ d'une chanson ne sauvegarde que cette chanson-là.
- La restauration se fait dans **Réglages** : elle **ajoute** les chansons de la sauvegarde sans rien effacer, et ne met à jour une chanson existante que si la sauvegarde est plus récente.
- Sur Android/Chromium, **Choisir un dossier de sauvegarde automatique** écrit un `okenechko-backup.json` à chaque modification. Sur iPhone, utilisez le menu ⋯ puis gardez le fichier (e-mail, Drive, AirDrop).
- Les données ne se synchronisent pas entre appareils **par conception** : transférez-les avec le fichier JSON.
- Une copie JSON conservée ailleurs reste la meilleure assurance contre un effacement manuel des données du navigateur.

## 7. Structure

```
okenechko/
├── index.html              Accueil, éditeur, lecteur, réglages
├── styles.css              Design sombre chaud + lecteur + menu ⋯ + @media print
├── app.js                  IndexedDB, éditeur, lecteur, exports, PWA
├── sw.js                   Service worker (cache hors-ligne)
├── manifest.webmanifest    Installation PWA
├── icons/                  Nouveau logo : PNG 64, 180, 192 et 512 px
└── README.md               Ce document
```

## 8. Compatibilité

Chrome / Edge / Android : toutes les fonctions, y compris la dictée vocale. Safari / iOS : installation, hors-ligne et sauvegarde via le menu ⋯ ; le dossier de sauvegarde automatique est réservé à Chromium. La dictée vocale repose sur la Web Speech API du navigateur : selon les appareils elle peut nécessiter une connexion Internet et n'est pas garantie en hors-ligne. Le micro exige une page servie en HTTPS (sauf `localhost`). Si la dictée n'est pas disponible, le bouton est désactivé et l'on peut toujours saisir les paroles au clavier.
