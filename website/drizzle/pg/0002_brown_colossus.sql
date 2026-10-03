CREATE INDEX "releases_archive_filename" ON "releases" USING btree (("extension_id" || '-' || "version" || '.json'));
