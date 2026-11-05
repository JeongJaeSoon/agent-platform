# Commit message attribution shared by everything in the image that writes a
# commit message: the hook dispatcher (werft-hook), the attribution repair
# tool and werft-commit source this file. Sourcing it only defines functions.
#
# The worker writes both inputs under $HOME/.werft from each claim: the
# session's trailers in git-trailers, and in git-strip the engine emails whose
# co-author lines go (the claim's git_strip, one email per line).

# Removes every Co-authored-by line (key in any case) whose email git-strip
# lists, a line folded over several lines included. Other lines, other
# co-authors included, are kept as written.
werft_strip_engine_coauthors() {
  _werft_file=$1
  _werft_strip=${HOME:-/nonexistent}/.werft/git-strip
  [ -n "$_werft_file" ] && [ -f "$_werft_file" ] && [ -f "$_werft_strip" ] ||
    return 0
  WERFT_STRIP_EMAILS=$(cat "$_werft_strip") awk '
    BEGIN {
      n = split(ENVIRON["WERFT_STRIP_EMAILS"], list, "\n")
      for (i = 1; i <= n; i++) {
        email = tolower(list[i])
        if (email != "" && email !~ /[ \t\r<>]/) engine[email] = 1
      }
    }
    # One record is a line with the lines folded under it: git joins a line
    # that starts with a space or tab to the one before, a whitespace-only
    # one included (runtime-core commit-attribution.ts unfolds the same way).
    # A blank record is never extended.
    function flush(   line, email) {
      if (!have) return
      have = 0
      line = unfolded
      sub(/\r$/, "", line)
      if (line ~ /^co-authored-by:/ && match(line, /<[^<>]*>[ \t]*$/)) {
        email = substr(line, RSTART + 1, RLENGTH - 1)
        sub(/>[ \t]*$/, "", email)
        if (email in engine) return
      }
      # Blank lines are held until a line follows, so a removed last line
      # leaves no blank tail for a verbatim commit-tree -F.
      if (record ~ /^[ \t\r]*$/) { held = held record "\n"; return }
      printf "%s%s\n", held, record
      held = ""
    }
    {
      if (have && record !~ /^[ \t\r]*$/ && $0 ~ /^[ \t]/) {
        text = $0
        sub(/^[ \t]+/, "", text)
        sub(/\r$/, "", text)
        sub(/\r$/, "", unfolded)
        record = record "\n" $0
        unfolded = unfolded " " tolower(text)
        next
      }
      flush()
      have = 1
      record = $0
      unfolded = tolower($0)
    }
    END { flush() }
  ' "$_werft_file" >"$_werft_file.werft-strip" || {
    rm -f "$_werft_file.werft-strip"
    return 1
  }
  cat "$_werft_file.werft-strip" >"$_werft_file" || return 1
  rm -f "$_werft_file.werft-strip"
}

# Adds the session's Co-authored-by and Agent-Session trailers unless the
# message already has the same line. Each line goes to git as one argv, never
# through the shell; a line with a CR or another key is skipped.
werft_add_trailers() {
  _werft_file=$1
  _werft_trailers=${HOME:-/nonexistent}/.werft/git-trailers
  [ -n "$_werft_file" ] && [ -f "$_werft_trailers" ] || return 0
  (
    cr=$(printf '\r')
    set --
    session=
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        *"$cr"*) continue ;;
        "Agent-Session: "*)
          [ -n "$session" ] || session=$line
          set -- "$@" --trailer "$line"
          ;;
        "Co-authored-by: "*) set -- "$@" --trailer "$line" ;;
      esac
    done <"$_werft_trailers"
    [ $# -gt 0 ] || exit 0
    # Outside any repository and with no config at all: a repository's or a
    # `git -c` trailer.* setting could otherwise rename these keys or run a
    # command that writes other lines.
    case $_werft_file in /*) ;; *) _werft_file=$PWD/$_werft_file ;; esac
    unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CONFIG GIT_CONFIG_PARAMETERS
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0
    cd / || exit 1
    # The trailers git reads must hold one Agent-Session line, the claim's. git
    # says which lines are trailers (--parse); of those, every Agent-Session
    # line but one exact copy of the claim's is deleted from the message,
    # last occurrence first, since the trailer block is the message's end. Body
    # text git does not read as a trailer is never matched. A message that
    # already holds exactly the one line is left as it is.
    if [ -n "$session" ]; then
      parsed=$(git interpret-trailers --parse --no-divider "$_werft_file") || exit 1
      found=$(printf '%s\n' "$parsed" | grep -ci '^agent-session:')
      exact=$(printf '%s\n' "$parsed" | grep -cxF "$session")
      if [ "$found" -gt 0 ] && { [ "$found" -ne 1 ] || [ "$exact" -ne 1 ]; }; then
        WERFT_PARSED=$parsed WERFT_SESSION=$session awk '
          BEGIN {
            n = split(ENVIRON["WERFT_PARSED"], p, "\n")
            for (i = 1; i <= n; i++) {
              if (tolower(p[i]) !~ /^agent-session:/) continue
              if (p[i] == ENVIRON["WERFT_SESSION"] && !kept) kept = 1
              else drop[p[i]]++
            }
          }
          { line[NR] = $0 }
          END {
            for (i = NR; i >= 1; i--) {
              text = line[i]
              sub(/\r$/, "", text)
              if (drop[text] > 0) { drop[text]--; gone[i] = 1 }
            }
            for (i = 1; i <= NR; i++) if (!gone[i]) print line[i]
          }
        ' "$_werft_file" >"$_werft_file.werft-session" || exit 1
        cat "$_werft_file.werft-session" >"$_werft_file" || exit 1
        rm -f "$_werft_file.werft-session"
      fi
    fi
    # --no-divider: the push check reads trailers the way `git log` does, which
    # treats a `---` line as ordinary text, so the trailers must go after it.
    exec git interpret-trailers --no-divider --if-exists addIfDifferent --in-place "$@" "$_werft_file"
  )
}

# Both, in that order. Running it again changes nothing.
werft_fix_message() {
  werft_strip_engine_coauthors "$1" && werft_add_trailers "$1"
}
