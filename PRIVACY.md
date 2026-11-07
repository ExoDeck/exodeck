# Privacy Policy for ExoDeck

**Last Updated:** November 7, 2026  
**Project:** ExoDeck (<https://github.com/ExoDeck/exodeck>)  
**Maintainer:** Dietmar Flick (<d_f@gmx.de>)

---

## 1. Overview and Core Philosophy

ExoDeck is designed with a **privacy-first, local-first philosophy**. It operates as a personal browser launchpad, cognitive cockpit, and knowledge management tool that runs entirely on your local machine.

We believe that your personal notes, links, tasks, diagrams, and encrypted vault secrets belong exclusively to you. ExoDeck does **not** collect, store, transmit, or monetize any personal data.

---

## 2. Information We Do Not Collect

When you run ExoDeck:

- **No Personal Identification Information (PII):** We do not collect names, email addresses, IP addresses, usernames, or contact details.
- **No Telemetry or Analytics:** ExoDeck contains no telemetry probes, crash-reporting SDKs, Google Analytics, or usage tracking mechanisms.
- **No Remote Phone-Home:** The application does not check in with external tracking servers or send heartbeat signals.
- **No Cookies or Tracking Pixels:** ExoDeck does not set tracking cookies or embed third-party analytics trackers.

---

## 3. Local Data Storage

All data created, imported, or edited in ExoDeck remains on your local computer:

- **Filesystem Storage:** Your pages, notes, link collections, and configurations are stored in your configured local directory (by default, `data/` within your ExoDeck installation).
- **Client-Side Vault Encryption:** Sensitive items stored in encrypted vaults are encrypted locally using AES-256-GCM authenticated encryption with Argon2id key derivation. Encryption and decryption occur entirely in local memory; master passwords and encryption keys never leave your machine.
- **Control of Your Data:** Because files are stored locally in standard formats (`.grid`, `.md`, `.json`, `.excalidraw`, `.bpmn`), you have full ownership and can backup, move, or delete your data at any time without third-party dependencies.

---

## 4. Network Communications

ExoDeck only performs network activity in the following specific contexts:

1. **Localhost Communication:** The frontend browser interface communicates exclusively with the local backend daemon running on your loopback interface (`http://127.0.0.1:8000` or your configured local port). This traffic never leaves your local network adapter.
2. **User-Initiated Navigation:** When you click external web links saved on your dashboard, your default web browser opens those URLs as standard web navigation. Those external websites are subject to their respective privacy policies.
3. **Optional External Integrations:** In accordance with our documented exceptions, Excalidraw or BPMN diagram components may load required static canvas assets. No user data, diagram contents, or notes are transmitted to external services.

---

## 5. Third-Party Services and Code Signing

- **GitHub:** ExoDeck source code and releases are hosted on GitHub (<https://github.com/ExoDeck/exodeck>). Interacting with the GitHub repository (e.g., submitting issues or downloading releases) is subject to the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **Code Signing (SignPath Foundation):** Release binaries are signed using open-source certificates provided by the [SignPath Foundation](https://signpath.org/). The signing process occurs in CI/CD build environments and involves binary artifacts only; no end-user data is involved or shared.

---

## 6. Children's Privacy

ExoDeck is a general-purpose, local productivity application that does not knowingly collect any data from children or any other users.

---

## 7. Changes to This Policy

Because ExoDeck is an open-source project with no telemetry or user tracking, any changes to this Privacy Policy will be reflected directly in this file in the GitHub repository.

---

## 8. Contact Information

If you have any questions, concerns, or inquiries regarding privacy in ExoDeck, please contact:

- **Maintainer:** Dietmar Flick
- **Email:** `d_f@gmx.de`
- **GitHub Issues:** <https://github.com/ExoDeck/exodeck/issues>
- **Security Advisories:** <https://github.com/ExoDeck/exodeck/security/advisories>
