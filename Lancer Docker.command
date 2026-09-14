#!/bin/bash
# Docker - Import Chine (macOS) : double-clic pour lancer. Au premier lancement : clic droit → Ouvrir.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js n'est pas installé. Installe-le depuis nodejs.org (version LTS) puis relance ce fichier."
  read -n 1 -s -r -p "Appuie sur une touche pour fermer."
  exit 1
fi
echo "Vérification des dépendances (rapide si rien n'a changé)..."
npm install --no-audit --no-fund || { echo "L'installation a échoué. Copie le message ci-dessus à Claude."; read -n 1 -s -r; exit 1; }
echo "Lancement de Docker... Laisse cette fenêtre ouverte tant que tu utilises l'application."
npm run dev
