#!/usr/bin/env bash
set -euo pipefail
umask 077
# Use the deployed Test MySQL container after coordinating the write freeze.
out=${1:?Pass a new private export directory}
mkdir -m 700 -- "$out"
docker exec lifewood-ubuntu-test-mysql-1 sh -ec 'export MYSQL_PWD="$(cat /run/secrets/mysql_root_password)"; exec mysqldump -u root --single-transaction --quick --hex-blob --routines --events --triggers --no-tablespaces --set-gtid-purged=OFF --skip-add-drop-table lifewood_aigc_test' | gzip -c > "$out/database.sql.gz.partial"
gzip -t "$out/database.sql.gz.partial"
gzip -dc "$out/database.sql.gz.partial" | tail -n 5 | grep -q 'Dump completed'
mv -- "$out/database.sql.gz.partial" "$out/database.sql.gz"
(cd "$out" && sha256sum database.sql.gz > database.sql.gz.sha256)

