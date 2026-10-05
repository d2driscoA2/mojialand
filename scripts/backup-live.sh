#!/bin/zsh
# Release 1.1.1 #43 (audit M5): weekly backup of the mojialand-live database.
# Runs on Danny's Mac every Sunday at 3:15 AM: launchd opens the Mojialand
# Backup app, which runs a copy of this file from
# ~/Library/Application Support/Mojialand (scripts/install-backup.sh sets this
# up). By hand:  zsh scripts/backup-live.sh
#
# - Reads the database password from the Mac keychain (item "mojialand-live-db").
#   The password never sits in this repo, in a file name, or in a chat.
# - Saves the public schema (all Mojialand tables) as one pg_dump file in
#   iCloud Drive, Work & Professional/Clients/Mojialand/Backups.
# - Checks the file: the row count of each main table inside the file must
#   match the live database. No restore into any database.
# - Keeps the newest 12 backups. Writes one line per run to backup-log.txt.
# - Shows a Mac notification when a run fails.
setopt ERR_EXIT PIPE_FAIL NO_UNSET

BIN=/opt/homebrew/opt/libpq/bin
DEST="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Work & Professional/Clients/Mojialand/Backups"
LOG="$DEST/backup-log.txt"
export PGHOST=aws-0-us-east-2.pooler.supabase.com PGPORT=5432 PGUSER=postgres.wkrveadsyqbmljaxrxxk PGDATABASE=postgres PGSSLMODE=require
TABLES=(passes devices granted_checkouts stripe_events settings support_messages campaigns)

mkdir -p "$DEST"
fail() {
  print -r -- "$(date '+%Y-%m-%d %H:%M') FAILED: $1" >> "$LOG"
  /usr/bin/osascript -e "display notification \"$1\" with title \"Mojialand backup failed\"" >/dev/null 2>&1 || true
  exit 1
}
trap 'fail "the script stopped early (line $LINENO)"' ZERR

PGPASSWORD="$(/usr/bin/security find-generic-password -s mojialand-live-db -a postgres -w 2>/dev/null)" || fail "no password in the keychain (item mojialand-live-db)"
export PGPASSWORD

STAMP=$(date +%Y-%m-%d-%H%M)
FILE="$DEST/mojialand-live-$STAMP.dump"
"$BIN/pg_dump" --schema=public --format=custom --no-owner --no-privileges --file="$FILE.part" 2>>"$LOG" || { rm -f "$FILE.part"; fail "pg_dump could not read the database"; }
mv "$FILE.part" "$FILE"

summary=()
for t in $TABLES; do
  # A table the live database does not have yet (before a release's SQL) is skipped.
  [[ "$("$BIN/psql" -tAc "select to_regclass('public.$t') is not null" 2>>"$LOG")" == "t" ]] || continue
  live=$("$BIN/psql" -tAc "select count(*) from public.$t" 2>>"$LOG") || fail "could not count $t"
  infile=$("$BIN/pg_restore" --data-only --table="$t" --file=- "$FILE" | awk '/^COPY /{c=1;next} /^\\\.$/{c=0} c' | wc -l | tr -d ' ')
  [[ "$live" == "$infile" ]] || fail "$t has $live rows live but $infile in the backup"
  summary+=("$t $live")
done
unset PGPASSWORD

# Keep the newest 12 backups.
ls -1t "$DEST"/mojialand-live-*.dump 2>/dev/null | tail -n +13 | while read -r old; do rm -f -- "$old"; done

size=$(du -h "$FILE" | cut -f1 | tr -d ' ')
print -r -- "$(date '+%Y-%m-%d %H:%M') OK $(basename "$FILE") $size rows: ${(j:, :)summary}" >> "$LOG"
print -r -- "Backup OK: $(basename "$FILE"), $size. Rows: ${(j:, :)summary}"
