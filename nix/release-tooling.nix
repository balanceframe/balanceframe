{ pkgs }:

let
  base = import ./tooling.nix { inherit pkgs; };

  # Release-specific tools on top of the base development tooling.
  releaseTools = with pkgs; [
    docker
    docker-buildx
    docker-compose
    syft
    cosign
    slsa-verifier
  ];
in

{
  packages = base.packages;

  nativeBuildInputs = base.nativeBuildInputs ++ releaseTools;

  buildInputs = base.buildInputs;

  commands =
    base.commands
    ++ [
      "docker"
      "docker-buildx"
      "docker-compose"
      "syft"
      "cosign"
      "slsa-verifier"
    ];
}
