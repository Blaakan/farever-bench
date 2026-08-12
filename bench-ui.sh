#!/bin/sh
# Open the bench UI in your own browser. The packaged desktop build is a
# Windows binary, so on Linux and macOS this is how you get the sheet - the
# server and the whole UI are plain Node and run anywhere Node does. This is
# `bench ui --open` and nothing else; every argument is forwarded verbatim.
#
# Farever itself runs here through Proton, so the install is usually under
# ~/.steam/steam/steamapps/common/Farever. Auto-detection reads Steam's own
# registry keys and only works on Windows, so name the folder if it is not
# found: ./bench-ui.sh --game ~/.steam/steam/steamapps/common/Farever
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not on your PATH. Install 18 or newer from https://nodejs.org/" >&2
  exit 1
fi
exec node "$(dirname "$0")/bin/bench.mjs" ui --open "$@"
