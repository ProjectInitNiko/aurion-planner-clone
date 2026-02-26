# 📅 Supmeca Planning — Aurion Schedule Viewer

Visualiseur d'emploi du temps pour **Supmeca** via la plateforme Aurion (`scolarite.supmeca.fr`).  
Interface moderne, responsive, avec vue Jour / Semaine / Liste.

![Dark Theme Login](https://img.shields.io/badge/theme-dark%20mode-blueviolet) ![Responsive](https://img.shields.io/badge/responsive-mobile%20%26%20desktop-blue) ![Node.js](https://img.shields.io/badge/backend-Node.js%20%2B%20Puppeteer-green)

## ✨ Fonctionnalités

- 🔐 **Connexion Aurion** — login sécurisé via scraping (rien n'est stocké)
- 📅 **3 vues** — Jour (mobile), Semaine (desktop), Liste
- 🎨 **Color-coding** — CM 🟣 / TD 🔵 / TP 🟢 / Exam 🔴 / Projet 🟡
- 📍 **Détails** — nom du cours, salle, professeur sur chaque créneau
- 📤 **Export ICS** — télécharger le planning pour Google Calendar / Outlook
- 💾 **Cache offline** — dernier planning sauvé en local
- 🌙 **Dark / Light mode**
- 📱 **100% responsive** — adapté téléphone, tablette, desktop

## 🏗️ Architecture

```
📱 Frontend (HTML/CSS/JS)  →  🔀 Backend Express + Puppeteer  →  🏫 scolarite.supmeca.fr
     port 5173 (dev)              port 3001                         Aurion JSF
```

## 🚀 Installation locale

```bash
# Cloner le repo
git clone https://github.com/ProjectInitNiko/aurion-planner-clone.git
cd aurion-planner-clone

# Installer les dépendances
npm install

# Lancer le backend (terminal 1)
node server.js

# Lancer le frontend (terminal 2)
npx serve -s . -l 5173 --cors

# Ouvrir http://localhost:5173
```

## 🌐 Déploiement sur VPS (Ubuntu + Nginx)

### Prérequis
- VPS Ubuntu avec Node.js et Nginx installés
- Un nom de domaine (ex: `planning.nikolos.pro`)
- Accès SSH au serveur

### 1. Installer les dépendances Puppeteer sur Ubuntu

```bash
sudo apt update
sudo apt install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxshmfence1 xdg-utils wget \
  chromium-browser
```

### 2. Cloner et installer le projet

```bash
cd /var/www
sudo git clone https://github.com/ProjectInitNiko/aurion-planner-clone.git
cd aurion-planner-clone
sudo npm install
```

### 3. Lancer avec PM2 (pour que ça tourne en permanence)

```bash
# Installer PM2
sudo npm install -g pm2

# Lancer le serveur backend
pm2 start server.js --name "supmeca-planning"
pm2 save
pm2 startup  # pour redémarrage auto
```

### 4. Configurer Nginx

```bash
sudo nano /etc/nginx/sites-available/planning.nikolos.pro
```

Coller cette config :

```nginx
server {
    listen 80;
    server_name planning.nikolos.pro;

    # Frontend — fichiers statiques
    root /var/www/aurion-planner-clone;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Backend API — proxy vers Node.js
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Activer le site :

```bash
sudo ln -s /etc/nginx/sites-available/planning.nikolos.pro /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5. DNS — ajouter un enregistrement A

Dans ton panel OVH, ajoute :
- **Type** : A
- **Sous-domaine** : `planning`
- **Cible** : l'IP de ton VPS

### 6. SSL avec Let's Encrypt (HTTPS)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d planning.nikolos.pro
```

### 7. Mettre à jour l'URL de l'API dans le frontend

Une fois en production, il faut changer l'URL de l'API dans `main.js` :

```bash
# Sur le VPS, éditer main.js
sudo nano /var/www/aurion-planner-clone/main.js
```

Changer la première ligne :
```javascript
// Remplacer :
const API_BASE = 'http://localhost:3001';
// Par :
const API_BASE = '';
```

Mettre `''` (vide) car Nginx redirige déjà `/api/*` vers le backend sur le même domaine.

---

## 📁 Structure du projet

| Fichier | Description |
|---------|-------------|
| `server.js` | Backend Express + Puppeteer (scraping Aurion) |
| `index.html` | Structure HTML de l'application SPA |
| `style.css` | Design system (dark/light, glassmorphism, responsive) |
| `main.js` | Logique frontend (calendrier, export, thème) |
| `package.json` | Configuration npm et dépendances |

## 🔒 Sécurité

- Les identifiants Aurion sont transmis au backend et envoyés directement à `scolarite.supmeca.fr`
- **Aucun mot de passe n'est stocké** — ni en base, ni dans des fichiers
- Les sessions Puppeteer sont automatiquement nettoyées après 30 minutes d'inactivité

## 📝 Crédits

Inspiré du projet [planningAurion](https://github.com/LBF38/planningAurion) par [@LBF38](https://github.com/LBF38) et [apiAurion](https://github.com/nicolegrimpeur/apiAurion) par [@nicolegrimpeur](https://github.com/nicolegrimpeur).
