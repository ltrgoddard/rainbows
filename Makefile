.PHONY: photos

photos: $(patsubst photos/raw/%.heic,photos/web/%.jpg,$(wildcard photos/raw/*.heic)) \
        $(patsubst photos/raw/%.HEIC,photos/web/%.jpg,$(wildcard photos/raw/*.HEIC))

photos/web/%.jpg: photos/raw/%.heic
	@mkdir -p photos/web
	sips -s format jpeg -Z 800 $< --out $@

photos/web/%.jpg: photos/raw/%.HEIC
	@mkdir -p photos/web
	sips -s format jpeg -Z 800 $< --out $@
