#!/bin/sh
# Notfall-Build ohne Vite (nur esbuild). Normalerweise reicht: npm run build
set -e
ESBUILD=${ESBUILD:-npx esbuild}
rm -rf dist && mkdir -p dist/assets
$ESBUILD src/main.tsx --bundle --minify --format=esm --jsx=automatic --target=es2020 \
  --define:process.env.NODE_ENV='"production"' --outfile=dist/assets/app.js
cp public/* dist/
sed -e 's#<script type="module" src="/src/main.tsx"></script>#<link rel="stylesheet" href="./assets/app.css" />\n    <script type="module" src="./assets/app.js"></script>#' index.html > dist/index.html
