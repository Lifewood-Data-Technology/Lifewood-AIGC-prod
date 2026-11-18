#!/usr/bin/env bash
set -euo pipefail
umask 077
dir=${1:?Pass the private dump directory}
login=${2:?Pass the mysql_config_editor login-path for the isolated production instance}
[[ ${3:-} == --restore-reviewed-empty-target ]] || { echo 'Explicit empty-target restore required' >&2; exit 2; }
(cd "$dir" && sha256sum -c database.sql.gz.sha256)
db=lifewood_aigc
client=(mysql "--login-path=$login" --database="$db")
# Operations must allocate an empty isolated schema, with no concurrent writers.
count=$("${client[@]}" -NBe "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE())+(SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema=DATABASE())+(SELECT COUNT(*) FROM information_schema.events WHERE event_schema=DATABASE())")
[[ $count == 0 ]] || { echo 'Target is not empty' >&2; exit 1; }
gzip -dc "$dir/database.sql.gz" | "${client[@]}"
"${client[@]}" -e 'SELECT version, completed FROM _lifewood_migrations ORDER BY version'

