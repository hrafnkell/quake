#!/bin/bash
# Afritar kóðann á VM og endurræsir þjónustuna.
# Notkun: deploy/deploy.sh notandi@vm
set -euo pipefail
TARGET=${1:?Notkun: deploy/deploy.sh notandi@vm}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude .git --exclude data --exclude node_modules --exclude .claude ./ "$TARGET:/tmp/quake-deploy/"
ssh "$TARGET" 'sudo rsync -a --delete /tmp/quake-deploy/ /opt/quake/ && sudo systemctl restart quake && systemctl --no-pager status quake | head -5'
