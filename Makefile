UUID = system-monitor@jtourteau
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES = extension.js prefs.js metadata.json schemas/

.PHONY: install uninstall zip schemas clean

schemas:
	glib-compile-schemas schemas/

install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(FILES) $(INSTALL_DIR)/
	@echo "Installed. Restart GNOME Shell and run: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)
	@echo "Uninstalled."

zip: schemas
	zip -r $(UUID).zip $(FILES)
	@echo "Created $(UUID).zip"

clean:
	rm -f $(UUID).zip
	rm -f schemas/gschemas.compiled
