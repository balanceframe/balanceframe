# Native Windows file-backed credential storage

Status: accepted for the narrow fail-closed implementation and synthetic tests.

## Context

The exported `EncryptedCredentialStore` writes encrypted credentials and a master
key in one directory. It requests POSIX file mode `0600` and directory mode `0700`.
Node does not implement owner/group/other distinctions through Windows file modes
([Node documentation](https://nodejs.org/api/fs.html#file-modes)). A Windows mode
assertion cannot prove access control, and the store neither sets nor verifies
Windows ACLs. Reading both key and ciphertext permits decryption. This gap
predates the v0.9 demo work; corrected CI failure gates exposed it.

## Decision

Reject construction on native Windows before inspecting options, resolving a
credential path or accessing the filesystem, including when a master key is
supplied. Preserve the existing POSIX implementation and its actual filesystem
permission, encryption, tamper detection and atomic-write tests.

Keep `EnvCredentialStore` explicit and available on all supported platforms. The
default application connection manager and web mutation executor already use it.
Do not silently substitute a store, migrate credentials, open existing Windows
credential files or delete them. No new package or native ACL implementation is
included. Environment injection is not an OS secret vault.

## Compatibility and verification

Explicit encrypted-file-store API consumers on native Windows must select the
existing environment-backed path instead. Upgrades leave old files untouched;
handling those files remains a separate operator action. Linux/Docker and other
POSIX callers retain existing behavior.

Tests must prove Windows refusal before any filesystem operation or option/path
inspection, including malformed options and supplied keys. Environment-backed
behavior remains tested on every platform. Persistence and permission tests apply
to supported platforms; Windows tests must exercise the refusal rather than
pretend to validate persistence or weaken POSIX security assertions. Native CI is
required in addition to simulated platform checks.

## Alternatives

Merely making permission assertions conditional would not establish the missing
Windows confidentiality guarantee. Verified Windows ACL or OS secret-store
support could restore persistence, but requires a separately reviewed design and
real security validation. Applying access controls after writing secrets risks an
exposure window and is not an equivalent substitute.
