UUID = system-monitor@jtourteau
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES = extension.js prefs.js metadata.json lib/ schemas/

.PHONY: install uninstall zip schemas clean

schemas:
	glib-compile-schemas schemas/

install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(FILES) $(INSTALL_DIR)/
	@echo "Installed. Restart GNOME Shell and run: gnome-extensions enable $(UUID)"

uninstall:
	-trash $(INSTALL_DIR)
	@echo "Uninstalled."

zip:
	zip -r $(UUID).zip $(FILES) -x "schemas/gschemas.compiled"
	@echo "Created $(UUID).zip"

clean:
	-trash $(UUID).zip
	-trash schemas/gschemas.compiled
