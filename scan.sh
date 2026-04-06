#!/usr/bin/env bash
# scan.sh — search Photos.app for rainbow photos, export new ones, and deploy
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
RAW="$REPO/photos/raw"
WEB="$REPO/photos/web"

mkdir -p "$RAW" "$WEB"

# false positives from Photos.app AI search (screenshots, etc.)
EXCLUDE=(IMG_3484 IMG_6890 IMG_6893 IMG_6878 IMG_6877 IMG_6855 IMG_6167 IMG_6051 IMG_5953 IMG_5951 IMG_5742 IMG_5740 IMG_5739 IMG_5738 IMG_5736 IMG_5071 IMG_5075 IMG_5073)

# ── 1. query Photos.app AI search ───────────────────────
echo "searching photos for rainbows…"

found=$(osascript -e '
tell application "Photos"
  set results to search for "rainbow"
  set fnames to {}
  repeat with p in results
    set end of fnames to filename of p
  end repeat
  return fnames
end tell' 2>/dev/null)

# parse comma-separated list into array
IFS=', ' read -ra photos <<< "$found"

if [ ${#photos[@]} -eq 0 ]; then
  echo "no rainbow photos found"
  exit 0
fi

echo "found ${#photos[@]} rainbow photos in Photos.app"

# ── 2. figure out which are new ─────────────────────────
new=()
for f in "${photos[@]}"; do
  stem="${f%.*}"
  # skip excluded files
  skip=false
  for ex in "${EXCLUDE[@]}"; do
    if [ "$stem" = "$ex" ]; then skip=true; break; fi
  done
  $skip && continue
  # check if raw/ already has it (case-insensitive)
  if ! find "$RAW" -maxdepth 1 -iname "${stem}.*" 2>/dev/null | grep -q .; then
    new+=("$f")
  fi
done

if [ ${#new[@]} -eq 0 ]; then
  echo "no new photos to export"
  exit 0
fi

echo "exporting ${#new[@]} new photos: ${new[*]}"

# ── 3. export new photos from Photos.app ────────────────
# build applescript to export only the new files
filelist=""
for f in "${new[@]}"; do
  filelist+="\"$f\", "
done
filelist="${filelist%, }"

osascript <<EOF
tell application "Photos"
  set results to search for "rainbow"
  set wanted to {${filelist}}
  set toExport to {}
  repeat with p in results
    if wanted contains (filename of p) then
      set end of toExport to p
    end if
  end repeat
  if (count of toExport) > 0 then
    export toExport to POSIX file "$RAW" with using originals
  end if
end tell
EOF

echo "exported to $RAW"

# ── 4. convert to web AVIF ─────────────────────────────
echo "converting to web format…"
make -C "$REPO" photos

# ── 5. update PHOTOS array in app.js ───────────────────
echo "updating app.js…"

# collect all web AVIFs, sorted newest-filename-first (descending)
all_imgs=()
while IFS= read -r f; do
  all_imgs+=("$(basename "$f")")
done < <(ls -1 "$WEB"/*.avif 2>/dev/null | sort -rV)

# build JS array string
js_array="const PHOTOS = ["
first=true
col=0
for img in "${all_imgs[@]}"; do
  entry="'${img}'"
  if [ "$first" = true ]; then
    js_array+=$'\n  '"$entry"
    first=false
    col=1
  else
    # ~5 per line for readability
    if [ $col -ge 5 ]; then
      js_array+=","$'\n  '"$entry"
      col=1
    else
      js_array+=",$entry"
      ((col++))
    fi
  fi
done
js_array+=$'\n];'

# replace the PHOTOS block in app.js
tmpfile=$(mktemp)
awk -v new_array="$js_array" '
  /^const PHOTOS = \[/ { printing=1; print new_array; next }
  printing && /\];/ { printing=0; next }
  printing { next }
  { print }
' "$REPO/app.js" > "$tmpfile"
mv "$tmpfile" "$REPO/app.js"

# ── 6. commit and push if there are changes ─────────────
cd "$REPO"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "no changes to commit"
  exit 0
fi

git add photos/web/ app.js
git commit -m "add $(printf '%s\n' "${new[@]}" | wc -l | tr -d ' ') new rainbow photo(s) from Photos.app

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
git push

echo "done — ${#new[@]} new rainbow photo(s) deployed"
