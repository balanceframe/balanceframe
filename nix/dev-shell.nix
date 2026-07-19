{ pkgs }:

let
  tooling = import ./tooling.nix { inherit pkgs; };
in

pkgs.mkShell {
  packages = tooling.packages;
  nativeBuildInputs = tooling.nativeBuildInputs;
  buildInputs = tooling.buildInputs;

  shellHook = ''
    printf '%s\n' \
      "BalanceFrame development shell" \
      "Canonical commands:" \
      "  nix develop" \
      "  nix flake show" \
      "  nix flake check" \
      "  just --list"
  '';
}
