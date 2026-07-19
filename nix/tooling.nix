{ pkgs }:

let
  # Rust financial core toolchain
  rust = with pkgs; [
    rustc
    cargo
    rustfmt
    clippy
    rust-analyzer
    cargo-nextest
    cargo-audit
    cargo-deny
  ];

  # Node.js + package manager bootstrap
  node = with pkgs; [
    nodejs_24
    corepack
  ];

  # N-API native build inputs (compiler/linker/toolchain go in nativeBuildInputs,
  # libraries go in buildInputs so pkg-config and header paths are correct)
  nativeBuildInputs = with pkgs; [
    pkgs.stdenv.cc
    gnumake
    pkg-config
    pnpm_10
  ];
  buildInputs = with pkgs; [
    openssl
    sqlite
  ];

  # Repository, server, password-bootstrap, and inspection tools
  repoTools = with pkgs; [
    git
    jq
    python3
    expect
    actual-server
    just
  ];
in
{
  formatter = pkgs.nixfmt-rfc-style;

  packages = [ pkgs.nixfmt-rfc-style ];

  nativeBuildInputs = rust ++ node ++ nativeBuildInputs ++ repoTools ++ [ pkgs.nixfmt-rfc-style ];

  buildInputs = buildInputs;

  # Canonical command names the shell must provide; used by checks
  commands = [
    "rustc"
    "cargo"
    "rustfmt"
    "cargo-clippy"
    "rust-analyzer"
    "cargo-nextest"
    "cargo-audit"
    "cargo-deny"
    "node"
    "npm"
    "corepack"
    "pnpm"
    "cc"
    "make"
    "pkg-config"
    "sqlite3"
    "git"
    "jq"
    "expect"
    "just"
    "actual-server"
  ];
}
