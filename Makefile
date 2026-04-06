SHELL    := /bin/bash
.PHONY: photos update scan deploy

RAW      := photos/raw
WEB      := photos/web
THUMB    := photos/thumb
EXCLUDE  := $(shell cat exclude.txt)

HEIC_LC  := $(wildcard $(RAW)/*.heic)
HEIC_UC  := $(wildcard $(RAW)/*.HEIC)
PNG_LC   := $(wildcard $(RAW)/*.png)
PNG_UC   := $(wildcard $(RAW)/*.PNG)
ALL_RAW  := $(HEIC_LC) $(HEIC_UC) $(PNG_LC) $(PNG_UC)
ALL_RAW  := $(filter-out $(foreach ex,$(EXCLUDE),$(wildcard $(RAW)/$(ex).*)),$(ALL_RAW))

WEB_OUT  := $(foreach f,$(ALL_RAW),$(WEB)/$(basename $(notdir $(f))).avif)
THUMB_OUT:= $(foreach f,$(ALL_RAW),$(THUMB)/$(basename $(notdir $(f))).avif)

# ── convert raw → avif (full + thumb) ─────────────────
photos: $(WEB_OUT) $(THUMB_OUT)

define to_avif
	@mkdir -p $(dir $@)
	sips -s format jpeg -Z $(1) $< --out $@.tmp.jpg
	avifenc -q $(2) --speed 4 $@.tmp.jpg $@
	@rm $@.tmp.jpg
endef

$(WEB)/%.avif: $(RAW)/%.heic;  $(call to_avif,2400,85)
$(WEB)/%.avif: $(RAW)/%.HEIC;  $(call to_avif,2400,85)
$(WEB)/%.avif: $(RAW)/%.png;   $(call to_avif,2400,85)
$(WEB)/%.avif: $(RAW)/%.PNG;   $(call to_avif,2400,85)

$(THUMB)/%.avif: $(RAW)/%.heic;  $(call to_avif,800,50)
$(THUMB)/%.avif: $(RAW)/%.HEIC;  $(call to_avif,800,50)
$(THUMB)/%.avif: $(RAW)/%.png;   $(call to_avif,800,50)
$(THUMB)/%.avif: $(RAW)/%.PNG;   $(call to_avif,800,50)

# ── update PHOTOS array in app.js, sorted by exif date ─
update: photos
	@echo "sorting photos by date…"
	@exiftool -DateTimeOriginal -filename -T $(RAW)/* 2>/dev/null \
	  | sort -rk1 \
	  | awk -F'\t' '{f=$$2; sub(/\.[^.]+$$/,".avif",f); print f}' \
	  | grep -v -F -f exclude.txt \
	  | while read -r f; do [ -f $(WEB)/$$f ] && echo $$f; done \
	  > photos/order.txt
	@awk ' \
	  NR==FNR { order[NR]=$$0; n=NR; next } \
	  /^const PHOTOS = \[/ { \
	    printf "const PHOTOS = [\n"; \
	    for(i=1;i<=n;i++) { \
	      if(i==1) printf "  '\''%s'\''", order[i]; \
	      else if((i-1)%5==0) printf ",\n  '\''%s'\''", order[i]; \
	      else printf ",'\''%s'\''", order[i]; \
	    } \
	    printf "\n];\n"; skip=1; next \
	  } \
	  skip && /\];/ { skip=0; next } \
	  skip { next } \
	  { print } \
	' photos/order.txt app.js > app.js.tmp && mv app.js.tmp app.js
	@echo "app.js updated ($$(wc -l < photos/order.txt | tr -d ' ') photos)"

# ── scan Photos.app, export, convert, update ───────────
scan:
	@echo "searching Photos.app for rainbows…"
	@found=$$(osascript -e ' \
	  tell application "Photos" \
	    set results to search for "rainbow" \
	    set fnames to {} \
	    repeat with p in results \
	      set end of fnames to filename of p \
	    end repeat \
	    return fnames \
	  end tell' 2>/dev/null); \
	IFS=', ' read -ra all <<< "$$found"; \
	new=(); \
	for f in "$${all[@]}"; do \
	  stem="$${f%.*}"; \
	  grep -qx "$$stem" exclude.txt && continue; \
	  find $(RAW) -maxdepth 1 -iname "$${stem}.*" 2>/dev/null | grep -q . && continue; \
	  new+=("$$f"); \
	done; \
	[ $${#new[@]} -eq 0 ] && echo "no new photos" && exit 0; \
	echo "exporting $${#new[@]} new: $${new[*]}"; \
	filelist=""; \
	for f in "$${new[@]}"; do filelist+="\"$$f\", "; done; \
	filelist="$${filelist%, }"; \
	osascript -e " \
	  tell application \"Photos\" \
	    set results to search for \"rainbow\" \
	    set wanted to {$$filelist} \
	    set toExport to {} \
	    repeat with p in results \
	      if wanted contains (filename of p) then set end of toExport to p \
	    end repeat \
	    if (count of toExport) > 0 then \
	      export toExport to POSIX file \"$$(pwd)/$(RAW)\" with using originals \
	    end if \
	  end tell"
	@$(MAKE) update

deploy: scan
	@if git diff --quiet && git diff --cached --quiet \
	  && [ -z "$$(git ls-files --others --exclude-standard)" ]; then \
	  echo "nothing to deploy"; exit 0; \
	fi
	git add $(WEB)/ $(THUMB)/ app.js
	git commit -m "add new rainbow photo(s) from Photos.app$$(printf '\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>')"
	git push
	@echo "deployed"
