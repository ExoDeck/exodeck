# Password Vault & Encryption Guide

> **ExoDeck Security & Cryptographic Architecture**  
> *How ExoDeck protects your credentials, OTP secrets, and private notes with local-first, zero-knowledge encryption.*

---

## 1. Overview & Trust Model

ExoDeck is designed as a **local-first, zero-cloud personal dashboard**. Unlike traditional browser start pages or cloud-hosted password managers, ExoDeck does not maintain remote servers, user databases, or telemetry pipelines.

When you store credentials (passwords, TOTP authenticator keys, or sensitive notes) in ExoDeck:

* **Zero-Knowledge**: Your master password is never stored on disk, never transmitted over the network, and never logged.
* **Local-Only Processing**: All cryptographic operations (key derivation, encryption, decryption, and TOTP generation) occur exclusively in local memory on your machine.
* **Modern Cryptography**: ExoDeck avoids outdated ciphers and proprietary schemes, relying exclusively on peer-reviewed, industry-standard primitives: **Argon2id** (RFC 9106) and **AES-256-GCM** (NIST SP 800-38D).

```text
[ Master Passphrase ]
         │
         ▼
[ Argon2id (64 MB RAM, 3 Passes, 16-Byte Random Salt) ]
         │
         ▼
[ 256-Bit Master Key in RAM ]
         │
    ┌────┴──────────────────────────────┐
    ▼                                   ▼
[ AES-256-GCM Encryption ]     [ AES-256-GCM Decryption ]
(Unique 96-Bit Nonce/Item)     (Authenticated Tag Check)
    │                                   │
    ▼                                   ▼
[ .grid Files (Ciphertext) ]    [ Plaintext in Memory Only ]
```

---

## 2. Cryptographic Specifications

| Component | Standard / Algorithm | Parameters & Configuration | Purpose |
| :--- | :--- | :--- | :--- |
| **Key Derivation (KDF)** | **Argon2id** (RFC 9106) | Memory: `64 MB`, Iterations: `3`, Threads: `4` | Derives a 256-bit cryptographic key resistant to GPU/ASIC brute-force attacks |
| **Symmetric Cipher** | **AES-256-GCM** | 256-bit key, 96-bit unique IV/Nonce per item | Provides authenticated encryption (confidentiality + cryptographic integrity) |
| **Random Number Generator** | **CSPRNG** | Go standard library `crypto/rand` | Generates cryptographically secure salts and nonces |
| **Integrity Verification** | **GMAC** (GCM 128-bit Tag) | 16-byte authentication tag per ciphertext | Detects any unauthorized modification or file tampering |
| **Two-Factor Authentication** | **TOTP** (RFC 6238) | HMAC-SHA1, 30s timestep, 6 digits | Generates 2FA verification codes locally from encrypted secrets |

---

## 3. How the Vault Works

### A. Key Derivation with Argon2id

When you initialize your vault, ExoDeck creates a 16-byte random salt using the operating system's cryptographically secure random number generator (`crypto/rand`).

Your master passphrase and the salt are fed into **Argon2id**, the winner of the international Password Hashing Competition. Argon2id combines:

* **Memory hardness** (requiring 64 MB of dedicated RAM per attempt), which makes massively parallel GPU and ASIC cracking economically unfeasible.
* **Resistance to side-channel and timing attacks**, ensuring safe execution across diverse hardware.

### B. Authenticated Encryption with AES-256-GCM

Every individual secret (a password field, a TOTP seed, or an encrypted markdown card) is encrypted independently:

1. A fresh, cryptographically random **96-bit nonce** is generated for every single encryption operation.
2. The data is encrypted using AES-256 in Galois/Counter Mode.
3. An **authentication tag (16 bytes)** is generated and appended to the ciphertext.
4. The result is stored as a tagged token: `gcm1:<base64-payload>`.

> [!IMPORTANT]
> Because GCM provides authenticated encryption, any attempt to tamper with, truncate, or alter the ciphertext on disk immediately causes authentication to fail. Decryption is aborted before any corrupt data can be processed.

### C. Zero-Knowledge Canary Verification

ExoDeck never stores a hash of your master password. Instead, the vault stores a cryptographic **Canary**:

* A known validation string (`EXODECK_VAULT_OK`) encrypted with your master key.
* When you enter your password to unlock the vault, ExoDeck derives the key and attempts to decrypt the canary.
* If the decrypted result matches the canary string, the vault unlocks.
* If decryption fails or authentication is invalid, the key is immediately discarded.

### D. In-Memory Protection & Auto-Locking

* **No Plaintext on Disk**: Plaintext credentials only exist in process memory when specifically viewed or requested.
* **Memory Scrubbing**: When the vault is locked (manually or via timeout), ExoDeck explicitly zeroes out the in-memory key buffer using a memory-scrubbing routine (`zeroBytes`) before releasing it to garbage collection.
* **Configurable Auto-Lock**: By default, the vault locks automatically after 30 minutes of inactivity (configurable in `config.json` via `"vault_timeout_minutes"`).

---

## 4. File-Based Storage & Portability

Your encrypted credentials live directly inside your local ExoDeck workspace files:

* **Vault Metadata** (`data/.exodeck_vault.json`): Contains the Argon2id parameters, the random salt, and the encrypted canary. It contains **no plaintext passwords**.
* **Page Data** (`data/*.grid`): Contains your dashboards and link collections. Secret fields use `gcm1:...` ciphertext tokens.

Because storage is 100% file-based:

* You can back up your vault by copying your `data/` folder.
* You can sync across devices using your own private Git repository (`git sync`), Syncthing, or local network backups without exposing secrets, because files on disk are always encrypted.

---

## 5. Comparison: ExoDeck vs. Cloud Password Managers

| Feature | ExoDeck Vault | Cloud Password Managers |
| :--- | :--- | :--- |
| **Hosting** | 100% Localhost / Offline | Third-Party Cloud Servers |
| **Telemetry & Tracking** | **Zero** (no analytics, no logs) | Often tracks usage, IP, and device metadata |
| **Account Requirement** | None (no registration, no email) | Mandatory cloud user account |
| **Network Exposure** | None (runs on loopback `127.0.0.1`) | Internet-facing sync endpoints |
| **Data Format** | Open JSON (`.grid`, `.json`) | Proprietary database or remote blob |
| **Data Ownership** | 100% User Sovereignty | Hosted on vendor infrastructure |

---

## 6. Recommended User Security Practices

To ensure maximum security when using ExoDeck as your local password and secret manager:

1. **Choose a Strong Master Passphrase**: Use a long, memorable passphrase (e.g., 4–5 random words using the Diceware method). Avoid reusing passwords from other accounts.
2. **Back Up Your Data Folder Regularly**: Make routine backups of your `data/` directory (including `.exodeck_vault.json` and all `.grid` files) to secure offline storage or encrypted media.
3. **Protect Your Host Machine**:
   * Enable full-disk encryption (BitLocker on Windows, FileVault on macOS, or LUKS on Linux).
   * Configure your operating system to lock the screen when stepping away.
   * Keep your operating system updated with the latest security patches.

---

## 7. Security & Password Management Disclaimer

> [!CAUTION]
> **Please read this disclaimer carefully before using ExoDeck to store sensitive credentials.**

1. **No Password Recovery (Zero Backdoors)**:  
   ExoDeck employs true end-to-end mathematical cryptography. There is **no backdoor, master recovery key, or reset mechanism**. If you forget or lose your master passphrase, **your encrypted vault data cannot be recovered by anyone, including the ExoDeck developers**.
2. **Endpoint Security Boundary**:  
   ExoDeck's encryption guarantees confidentiality and integrity for data stored on disk and during transit over your local loopback. However, cryptographic software cannot defend against an inherently compromised host operating system.
   If your device is infected with active keyloggers, screen scrapers, or memory-inspection malware, your master password and decrypted credentials could be intercepted at the operating system level.
3. **Backup Responsibility**:  
   You are solely responsible for maintaining regular, secure backups of your ExoDeck workspace directories. The authors and contributors of ExoDeck accept no liability for data loss resulting from forgotten passwords, disk failures, or unbacked-up vaults.
4. **License & Warranty**:  
   As specified in the [MIT License](License.md), ExoDeck is provided *"AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and noninfringement*.
