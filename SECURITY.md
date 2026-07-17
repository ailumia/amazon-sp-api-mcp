# Security policy

## Supported versions

Security fixes are provided for the latest released major version. Users should upgrade to the latest patch release before reporting a reproducibility problem.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include the affected version or commit, impact, reproduction steps, and any suggested mitigation.

If private reporting is unavailable, email `security@ailumia.com`. Do not include live Amazon credentials, seller PII, or report data. Do not open a public issue until a maintainer confirms that disclosure is safe.

We aim to acknowledge reports within five business days. Timelines for validation, remediation, and coordinated disclosure depend on severity and complexity.

## Scope

Examples of in-scope reports include:

- credential or token disclosure;
- confirmation-policy bypasses for write or delete operations;
- arbitrary file access through artifacts;
- request smuggling, SSRF, or authorization bypass in Streamable HTTP mode;
- malicious model files that compromise the registry generator;
- dependency vulnerabilities with a demonstrated impact on this server.

Amazon account recovery, Amazon platform vulnerabilities, and seller authorization disputes should be reported to Amazon through its official channels.
