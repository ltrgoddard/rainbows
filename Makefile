.PHONY: photos

HEIC_LC  := $(patsubst photos/raw/%.heic,photos/web/%.avif,$(wildcard photos/raw/*.heic))
HEIC_UC  := $(patsubst photos/raw/%.HEIC,photos/web/%.avif,$(wildcard photos/raw/*.HEIC))
PNG_LC   := $(patsubst photos/raw/%.png,photos/web/%.avif,$(wildcard photos/raw/*.png))
PNG_UC   := $(patsubst photos/raw/%.PNG,photos/web/%.avif,$(wildcard photos/raw/*.PNG))

photos: $(HEIC_LC) $(HEIC_UC) $(PNG_LC) $(PNG_UC)

# two-step: sips resizes to 1600px JPEG tmp, avifenc encodes to AVIF with EXIF
define to_avif
	@mkdir -p photos/web
	sips -s format jpeg -Z 1600 $< --out $@.tmp.jpg
	avifenc -q 60 --speed 4 $@.tmp.jpg $@
	@rm $@.tmp.jpg
endef

photos/web/%.avif: photos/raw/%.heic
	$(to_avif)

photos/web/%.avif: photos/raw/%.HEIC
	$(to_avif)

photos/web/%.avif: photos/raw/%.png
	$(to_avif)

photos/web/%.avif: photos/raw/%.PNG
	$(to_avif)
