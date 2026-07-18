{ pkgs, root }:

let
  tooling = import ./tooling.nix { inherit pkgs; };

  # Formatter check: run nixfmt in check mode against all .nix files
  nix-format =
    pkgs.runCommand "nix-format-check"
      {
        nativeBuildInputs = [ pkgs.nixfmt-rfc-style ];
      }
      ''
        cd ${root}
        for f in flake.nix nix/*.nix; do
          if ! nixfmt --check "$f"; then
            echo "FAIL: $f is not formatted" >&2
            exit 1
          fi
        done
        touch "$out"
      '';

  # Source-check: verify required files exist and flake.lock is valid JSON
  flake-source =
    pkgs.runCommand "flake-source-check"
      {
        nativeBuildInputs = [ pkgs.jq ];
      }
      ''
        cd ${root}
        for f in flake.nix flake.lock nix/dev-shell.nix nix/tooling.nix nix/checks.nix; do
          test -f "$f" || { echo "missing: $f" >&2; exit 1; }
        done
        # Validate flake.lock as JSON
        jq empty flake.lock || { echo "flake.lock is not valid JSON" >&2; exit 1; }
        touch "$out"
      '';

  # Shell-tools check: verify all declared tools are available from
  # declared derivation inputs only (not ambient PATH)
  shell-tools =
    pkgs.runCommand "shell-tools-check"
      {
        nativeBuildInputs = tooling.packages ++ tooling.nativeBuildInputs;
        buildInputs = tooling.buildInputs;
      }
      ''
        for tool in \
          rustc cargo rustfmt cargo-clippy rust-analyzer \
          cargo-nextest cargo-audit cargo-deny \
          node npm corepack pnpm cc make pkg-config openssl \
          sqlite3 git jq python3 nixfmt; do
          path="$(command -v "$tool" 2>/dev/null)" || {
            echo "missing command: $tool" >&2
            exit 1
          }
          case "$path" in
            /nix/store/*) ;;
            *)
              echo "ambient tool path for $tool: $path" >&2
              exit 1
              ;;
          esac
        done
        touch "$out"
      '';

in
{
  nix-format = nix-format;
  flake-source = flake-source;
  shell-tools = shell-tools;
}
