#!/bin/sh
# Build NDS Performance and copy it into Live's User Library (or a folder given as $1).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
DEST="${1:-$HOME/Music/Ableton/User Library/Presets/Instruments/Max Instrument/NDS Performance}"
/usr/bin/python3 "$HERE/build.py" --fallback-dir "$DEST"
mkdir -p "$DEST"
cp "$HERE/dist/NDS-Performance.amxd" "$HERE/dist/NDS-Performance.html" "$DEST/"
echo "installed to $DEST"
