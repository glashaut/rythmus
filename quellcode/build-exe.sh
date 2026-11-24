#!/bin/sh
# Baut Rhythmus.exe (Windows) aus dem fertigen Web-Build in dist/. Benötigt Go 1.24+.
set -e
cd "$(dirname "$0")"
rm -rf launcher/dist && cp -r dist launcher/dist
cd launcher
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o ../Rhythmus.exe .
echo "fertig: Rhythmus.exe"
