#!/usr/bin/env bash
# Install the OpenPaper CLI on macOS or Linux.
#
#   curl -fsSL https://github.com/arshit09/OpenPaper/releases/latest/download/install.sh | bash
#
# Installs the `openpaper` command: the OpenPaper server and editor, a Node.js runtime of its own, and the voice
# input engine for this machine. No root needed. Every download is checked against its SHA-256 before it's used.
#
#   ~/.local/share/openpaper/server/   OpenPaper, from this project's GitHub release
#   ~/.local/share/openpaper/node/     Node.js, the official build from nodejs.org
#   ~/.local/bin/openpaper             the command
#
# Your designs live in ~/.openpaper and are never touched. Running the script again updates in place.
# `openpaper uninstall` removes the CLI.
#
# Environment (all optional):
#   OPENPAPER_VERSION          a version to install, such as 0.3.0 (default: the latest release)
#   OPENPAPER_INSTALL_DIR      where to install (default: ~/.local/share/openpaper)
#   OPENPAPER_BIN_DIR          where to put the command (default: ~/.local/bin)
#   OPENPAPER_MANIFEST_URL     read this release manifest instead of GitHub's
#   OPENPAPER_NODE_MIRROR      download Node.js from this mirror of https://nodejs.org/dist
#   OPENPAPER_NO_SPEECH=1      skip the voice input engine (about 35 MB)
#   OPENPAPER_NO_MODIFY_PATH=1 don't add the command's folder to your shell profile

set -euo pipefail

REPO_URL="https://github.com/arshit09/OpenPaper"
PATH_MARKER="# Added by the OpenPaper installer"

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' RESET=$'\033[0m'
else
  BOLD="" DIM="" RED="" RESET=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s\n' "${DIM}>${RESET} $*"; }
warn() { printf '%s\n' "${BOLD}warning:${RESET} $*" >&2; }
fail() {
  printf '%s\n' "${RED}${BOLD}error:${RESET} $*" >&2
  exit 1
}

# Quote a string for a POSIX shell script.
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

has() { command -v "$1" >/dev/null 2>&1; }

# download <url> <file> [show-progress]
download() {
  if has curl; then
    if [ "${3:-}" = progress ] && [ -t 2 ]; then
      curl -fL --retry 3 --progress-bar -o "$2" "$1"
    else
      curl -fsSL --retry 3 -o "$2" "$1"
    fi
  elif has wget; then
    if [ "${3:-}" = progress ] && [ -t 2 ]; then
      wget -q --show-progress -O "$2" "$1"
    else
      wget -q -O "$2" "$1"
    fi
  else
    fail "curl or wget is needed to download OpenPaper."
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif has openssl; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    fail "sha256sum, shasum or openssl is needed to check downloads."
  fi
}

# verify <file> <expected sha256> <what>
verify() {
  local actual
  actual="$(sha256_of "$1")"
  [ "$actual" = "$2" ] || fail "$3 doesn't match its published SHA-256 (expected $2, got $actual). Try again, or report it at $REPO_URL/issues."
}

# Read a string or number field from the release manifest (flat JSON, one key per line).
manifest_field() {
  sed -n "s/^[[:space:]]*\"$2\":[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*\$/\1/p" "$1" | head -n 1
}

# A URL from the manifest, resolved against the manifest's own URL when it's relative.
resolve_url() {
  case "$1" in
    http://* | https://*) printf '%s' "$1" ;;
    *) printf '%s/%s' "${2%/*}" "$1" ;;
  esac
}

detect_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) fail "On Windows, use PowerShell: irm $REPO_URL/releases/latest/download/install.ps1 | iex" ;;
    *) fail "OpenPaper's CLI installer supports macOS and Linux. On $(uname -s), run it from source: $REPO_URL#readme" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "There's no Node.js build for $(uname -m) that OpenPaper can use. Run it from source: $REPO_URL#readme" ;;
  esac
  # A Terminal running under Rosetta reports x86_64 on Apple silicon; use the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  if [ "$os" = linux ]; then
    if ls /lib/ld-musl-* >/dev/null 2>&1; then
      fail "This looks like a musl Linux (such as Alpine), which the official Node.js builds don't support. Run OpenPaper from source: $REPO_URL#readme"
    fi
    local glibc
    glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
    if [ -n "$glibc" ]; then
      local major="${glibc%%.*}" minor="${glibc#*.}"
      minor="${minor%%.*}"
      if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 28 ]; }; then
        fail "Node.js needs glibc 2.28 or later; this system has $glibc."
      fi
    fi
  fi
  printf '%s-%s' "$os" "$arch"
}

# PIDs of OpenPaper servers running from this install: `<node> <install>/server/cli.js serve ...`.
servers_from() {
  local cli="$1" pid args
  has ps || return 0
  { ps -A -ww -o pid= -o command= 2>/dev/null || true; } | while read -r pid args; do
    case "$args" in
      *" $cli serve" | *" $cli serve "*) printf '%s\n' "$pid" ;;
    esac
  done
}

stop_servers() {
  local pids pid waited=0
  pids="$(servers_from "$1")"
  [ -n "$pids" ] || return 1
  step "Stopping the OpenPaper server running from this install"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  while [ "$waited" -lt 100 ]; do
    local alive=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ -n "$alive" ] || return 0
    sleep 0.1
    waited=$((waited + 1))
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
  return 0
}

profile_for_shell() {
  case "$(basename "${SHELL:-}")" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = Darwin ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi
      ;;
    fish) printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/openpaper.fish" ;;
    *) printf '%s' "$HOME/.profile" ;;
  esac
}

# Prints the profile it changed, if any.
add_to_path() {
  local bin_dir="$1" profile line
  case ":$PATH:" in *":$bin_dir:"*) return 0 ;; esac
  [ "${OPENPAPER_NO_MODIFY_PATH:-}" = 1 ] && return 0
  profile="$(profile_for_shell)"
  if [ "${profile##*.}" = fish ]; then
    line="fish_add_path $(shell_quote "$bin_dir")"
  else
    line="export PATH=$(shell_quote "$bin_dir"):\"\$PATH\""
  fi
  if [ -f "$profile" ] && grep -qF "$bin_dir" "$profile"; then
    printf '%s' "$profile"
    return 0
  fi
  mkdir -p "$(dirname "$profile")"
  printf '\n%s\n%s\n' "$PATH_MARKER" "$line" >>"$profile"
  printf '%s' "$profile"
}

write_command() {
  local file="$1" dir="$2"
  local q_dir q_node q_cli q_uninstall
  q_dir="$(shell_quote "$dir")"
  q_node="$(shell_quote "$dir/node/bin/node")"
  q_cli="$(shell_quote "$dir/server/cli.js")"
  q_uninstall="$(shell_quote "$dir/uninstall.sh")"
  cat >"$file" <<EOF
#!/bin/sh
# The openpaper command, written by the OpenPaper installer. Install folder: $q_dir
if [ "\$1" = uninstall ]; then exec sh $q_uninstall; fi
exec $q_node $q_cli "\$@"
EOF
  chmod 755 "$file"
}

write_uninstaller() {
  local dir="$1" command_file="$2"
  local q_dir q_command q_cli
  q_dir="$(shell_quote "$dir")"
  q_command="$(shell_quote "$command_file")"
  q_cli="$(shell_quote "$dir/server/cli.js")"
  cat >"$dir/uninstall.sh" <<EOF
#!/bin/sh
# Remove the OpenPaper CLI. Your designs in ~/.openpaper stay.
dir=$q_dir
cli=$q_cli
pids=\$( (ps -A -ww -o pid= -o command= 2>/dev/null || true) | while read -r pid args; do
  case "\$args" in *" \$cli serve" | *" \$cli serve "*) echo "\$pid" ;; esac
done)
if [ -n "\$pids" ]; then
  echo "Stopping OpenPaper"
  kill -TERM \$pids 2>/dev/null || true
  sleep 2
fi
rm -f $q_command
# The PATH lines the installer added: each is the marker comment and the line after it.
for profile in "\$HOME/.bashrc" "\$HOME/.bash_profile" "\${ZDOTDIR:-\$HOME}/.zshrc" "\$HOME/.profile"; do
  if [ -f "\$profile" ] && grep -qxF '$PATH_MARKER' "\$profile"; then
    awk -v marker='$PATH_MARKER' '\$0 == marker { skip = 2 } skip > 0 { skip--; next } { print }' "\$profile" >"\$profile.openpaper-tmp" &&
      cat "\$profile.openpaper-tmp" >"\$profile"
    rm -f "\$profile.openpaper-tmp"
  fi
done
rm -f "\${XDG_CONFIG_HOME:-\$HOME/.config}/fish/conf.d/openpaper.fish"
rm -rf "\$dir"
echo "OpenPaper CLI removed. Your designs are still in \${OPENPAPER_HOME:-\$HOME/.openpaper}."
EOF
  chmod 755 "$dir/uninstall.sh"
}

main() {
  has tar || fail "tar is needed to unpack OpenPaper."
  has uname || fail "uname is needed to detect your system."

  local target os
  target="$(detect_target)"
  os="${target%-*}"

  local install_dir bin_dir
  install_dir="${OPENPAPER_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openpaper}"
  bin_dir="${OPENPAPER_BIN_DIR:-$HOME/.local/bin}"
  case "$install_dir" in /*) ;; *) install_dir="$PWD/$install_dir" ;; esac
  case "$bin_dir" in /*) ;; *) bin_dir="$PWD/$bin_dir" ;; esac

  local manifest_url
  if [ -n "${OPENPAPER_MANIFEST_URL:-}" ]; then
    manifest_url="$OPENPAPER_MANIFEST_URL"
  elif [ -n "${OPENPAPER_VERSION:-}" ]; then
    manifest_url="$REPO_URL/releases/download/v${OPENPAPER_VERSION#v}/OpenPaper-cli.json"
  else
    manifest_url="$REPO_URL/releases/latest/download/OpenPaper-cli.json"
  fi

  mkdir -p "$install_dir" "$bin_dir"
  # Leftovers from an interrupted run.
  rm -rf "$install_dir"/.install.* "$install_dir/.server-old" "$install_dir/.node-old"
  # Unpack next to the install, so swapping it in is a rename.
  local work
  work="$(mktemp -d "$install_dir/.install.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf $(shell_quote "$work")" EXIT

  say "${BOLD}Installing OpenPaper${RESET} ${DIM}($target)${RESET}"
  download "$manifest_url" "$work/manifest.json" || fail "Couldn't read the release manifest at $manifest_url"
  local version bundle_url bundle_sha node_version
  version="$(manifest_field "$work/manifest.json" version)"
  bundle_url="$(manifest_field "$work/manifest.json" url)"
  bundle_sha="$(manifest_field "$work/manifest.json" sha256)"
  node_version="$(manifest_field "$work/manifest.json" node)"
  [ -n "$version" ] && [ -n "$bundle_url" ] && [ -n "$bundle_sha" ] && [ -n "$node_version" ] ||
    fail "The release manifest at $manifest_url is missing fields."
  bundle_url="$(resolve_url "$bundle_url" "$manifest_url")"

  # 1. OpenPaper.
  step "Downloading OpenPaper $version"
  download "$bundle_url" "$work/openpaper.tar.gz" progress || fail "Couldn't download $bundle_url"
  verify "$work/openpaper.tar.gz" "$bundle_sha" "The OpenPaper download"
  mkdir -p "$work/stage"
  tar -xzf "$work/openpaper.tar.gz" -C "$work/stage"
  [ -f "$work/stage/server/cli.js" ] || fail "The OpenPaper download is missing server/cli.js."

  # 2. Node.js, unless this install already has the same version.
  local node_dir="$install_dir/node" new_node=""
  if [ "$("$node_dir/bin/node" --version 2>/dev/null || true)" != "v$node_version" ]; then
    local mirror="${OPENPAPER_NODE_MIRROR:-https://nodejs.org/dist}"
    local ext=tar.gz flag=z
    if [ "$os" = darwin ] || has xz; then ext=tar.xz flag=J; fi
    local name="node-v$node_version-$target"
    step "Downloading Node.js $node_version"
    download "$mirror/v$node_version/SHASUMS256.txt" "$work/SHASUMS256.txt" || fail "Couldn't read Node.js checksums from $mirror"
    local node_sha
    node_sha="$(awk -v f="$name.$ext" '$2 == f { print $1 }' "$work/SHASUMS256.txt")"
    [ -n "$node_sha" ] || fail "nodejs.org has no $name.$ext."
    download "$mirror/v$node_version/$name.$ext" "$work/node.$ext" progress || fail "Couldn't download Node.js from $mirror"
    verify "$work/node.$ext" "$node_sha" "The Node.js download"
    mkdir -p "$work/node"
    tar -x${flag}f "$work/node.$ext" -C "$work/node" --strip-components=1 "$name/bin/node" "$name/LICENSE"
    chmod 755 "$work/node/bin/node"
    new_node=1
  fi

  # 3. The voice input engine (optional: OpenPaper works without it, minus dictation).
  local speech_url speech_sha
  speech_url="$(manifest_field "$work/manifest.json" "speech-$target-url")"
  speech_sha="$(manifest_field "$work/manifest.json" "speech-$target-sha256")"
  if [ "${OPENPAPER_NO_SPEECH:-}" != 1 ] && [ -n "$speech_url" ] && [ -n "$speech_sha" ]; then
    step "Downloading the voice input engine"
    speech_url="$(resolve_url "$speech_url" "$manifest_url")"
    local speech_dir="$work/stage/server/node_modules/sherpa-onnx-$target"
    if download "$speech_url" "$work/speech.tgz" progress && [ "$(sha256_of "$work/speech.tgz")" = "$speech_sha" ]; then
      mkdir -p "$speech_dir"
      tar -xzf "$work/speech.tgz" -C "$speech_dir" --strip-components=1 || warn "Couldn't unpack the voice input engine; dictation will be unavailable."
    else
      warn "Couldn't download the voice input engine; dictation will be unavailable. Everything else works."
    fi
  fi

  # 4. Swap it in. A server running from this install is stopped first and started again after.
  local restarted=""
  stop_servers "$install_dir/server/cli.js" && restarted=1
  if [ -n "$new_node" ]; then
    rm -rf "$install_dir/.node-old"
    [ -d "$node_dir" ] && mv "$node_dir" "$install_dir/.node-old"
    mv "$work/node" "$node_dir"
    rm -rf "$install_dir/.node-old"
  fi
  rm -rf "$install_dir/.server-old"
  [ -d "$install_dir/server" ] && mv "$install_dir/server" "$install_dir/.server-old"
  if ! mv "$work/stage/server" "$install_dir/server"; then
    [ -d "$install_dir/.server-old" ] && mv "$install_dir/.server-old" "$install_dir/server"
    fail "Couldn't move OpenPaper into $install_dir."
  fi
  rm -rf "$install_dir/.server-old"

  # 5. The command, the uninstaller and PATH.
  local command_file="$bin_dir/openpaper" profile
  write_command "$command_file" "$install_dir"
  profile="$(add_to_path "$bin_dir")"
  write_uninstaller "$install_dir" "$command_file"

  local installed
  installed="$("$command_file" --version 2>/dev/null </dev/null)" || fail "OpenPaper was installed, but \`$command_file --version\` failed."
  if [ -n "$restarted" ]; then
    "$command_file" start --no-open </dev/null >/dev/null 2>&1 || warn "Couldn't restart the server. Run \`openpaper start\`."
  fi

  say ""
  say "${BOLD}OpenPaper $installed is installed.${RESET}"
  say ""
  say "  openpaper start                  ${DIM}# open the editor${RESET}"
  say "  openpaper install claude-code    ${DIM}# connect an agent (or --all)${RESET}"
  say ""
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      if [ -n "$profile" ]; then
        say "Open a new terminal to use it, or run:  ${BOLD}export PATH=$(shell_quote "$bin_dir"):\"\$PATH\"${RESET}"
      else
        say "Add $bin_dir to your PATH to use it, or run $command_file."
      fi
      ;;
  esac
}

main "$@"
