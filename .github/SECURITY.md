# Security Policy

## Reporting a Vulnerability

The BalanceFrame team takes security vulnerabilities seriously. If you
discover a security issue in BalanceFrame, please report it privately
before disclosing it publicly.

**Do not report security vulnerabilities through public GitHub issues.**

Instead, please send an email to:

**security@balanceframe.com**

You should receive a response within 48 hours. If you do not receive a
response, please follow up to ensure your message was received.

### What to Include

To help us respond quickly, please include:

- A clear description of the vulnerability
- Steps to reproduce the issue, including any required environment
  configuration
- Affected versions or components (if known)
- Any potential impact you have identified
- Your preferred contact method for follow-up questions

### Response Timeline

| Timeframe | Action |
|-----------|--------|
| Within 48 hours | Initial acknowledgment of your report |
| Within 5 business days | Initial triage and severity assessment |
| Within 14 days | Plan for fix, mitigation, or accepted risk |
| As determined | Release of fix and coordinated public disclosure |

We strive to keep you informed of progress throughout the resolution
process.

### Disclosure Policy

We follow a coordinated disclosure process:

1. The reporter submits the vulnerability privately.
2. The maintainers acknowledge receipt and begin investigation.
3. A fix is developed and tested.
4. The fix is released, and the vulnerability is publicly disclosed
   with an advisory and credit to the reporter (unless the reporter
   prefers to remain anonymous).
5. We request that reporters allow reasonable time for a fix to be
   developed before any public disclosure.

## PGP Key

A PGP key for encrypted vulnerability reports will be published here
when the project reaches its initial public release. Until then, please
use the email address above with standard encryption or contact the
maintainers via a mutually trusted channel.

## Supported Versions

BalanceFrame is currently in pre-release development. Until a stable
release is published, security fixes will be applied to the default
branch and released as part of the next milestone.

## Security Considerations for Self-Hosters

BalanceFrame is a self-hosted application that integrates with Actual
Budget. When deploying:

- Use a dedicated, non-privileged user account for the BalanceFrame
  process.
- Serve BalanceFrame over HTTPS in production.
- Restrict network access to the BalanceFrame API to authorized clients.
- Keep your Actual Budget instance up to date.
- Use environment variables or a secrets manager for credentials and
  API keys; do not hardcode secrets into configuration files.
- Review any model providers or inference endpoints you configure for
  their data-handling policies.

## Threat Model

BalanceFrame's security architecture is grounded in the following
principles:

- **Actual remains independently usable.** A compromise of BalanceFrame
  must not compromise the Actual ledger. BalanceFrame is a consumer
  of Actual's API with scoped authorization only.
- **Least privilege.** Components and providers receive only the
  capabilities they need to perform their function.
- **Deterministic authority.** All financial mutations are authored
  by deterministic Rust code; model output is untrusted until
  validated and authorized.
- **No third-party code execution.** The N-API boundary is the
  only native code interface; no plugin, scripting, or dynamic
  loading of untrusted code is permitted.

If you have questions about the threat model or security architecture,
please reach out via the reporting address above.
