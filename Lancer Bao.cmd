@echo off
title Bao - Import Chine
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe ou pas encore visible. Installe-le depuis nodejs.org puis relance ce fichier.
  pause
  exit /b 1
)

echo Verification des dependances (rapide si rien n'a change)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo L'installation a echoue. Copie le message ci-dessus a Claude.
  pause
  exit /b 1
)

echo Lancement de Bao... Laisse cette fenetre ouverte tant que tu utilises l'application.
call npm run dev
pause
