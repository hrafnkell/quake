#!/bin/bash
# Afritar kóðann á netþjón og (endur)ræsir systemd notendaþjónustuna.
# Notkun: deploy/deploy.sh [ssh-hýsill] [slóð]   (sjálfgefið: elmer srv/quake)
set -euo pipefail
HOST=${1:-elmer}
DIR=${2:-srv/quake}
SSH=(ssh -o ClearAllForwardings=yes "$HOST")
cd "$(dirname "$0")/.."

# data/ (gagnagrunnurinn) og .env eru undanskilin og því aldrei yfirskrifuð né eytt
rsync -az --delete -e "ssh -o ClearAllForwardings=yes" \
  --exclude .git --exclude data --exclude .env --exclude node_modules --exclude .claude \
  ./ "$HOST:$DIR/"

"${SSH[@]}" "DIR=$DIR bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p ~/.config/systemd/user "$HOME/$DIR/data"
cp "$HOME/$DIR/deploy/quake.service" ~/.config/systemd/user/quake.service
systemctl --user daemon-reload
systemctl --user enable quake >/dev/null 2>&1
systemctl --user restart quake
sleep 2
systemctl --user --no-pager status quake | head -4
PORT=$(systemctl --user show quake -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p')
curl -fsS "http://127.0.0.1:${PORT:-3060}/api/status" && echo
REMOTE
