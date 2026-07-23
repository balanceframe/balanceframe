{ pkgs }:

let
  tooling = import ./release-tooling.nix { inherit pkgs; };
in

pkgs.mkShell {
  packages = tooling.packages;
  nativeBuildInputs = tooling.nativeBuildInputs;
  buildInputs = tooling.buildInputs;

  shellHook = ''
    printf '%s\n' \
      "Balanceframe release shell" \
      "Release commands:" \
      "  just release-verify TAG=<tag>" \
      "  just release-assets TAG=<tag> DIGEST=<sha256>" \
      "  nix flake check"
  '';
}
