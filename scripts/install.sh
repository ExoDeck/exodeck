#!/usr/bin/env sh
# ExoDeck installer for Linux and macOS
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ExoDeck/exodeck/main/scripts/install.sh | bash
# Or:
#   ./scripts/install.sh

set -e

REPO="ExoDeck/exodeck"
BINARY="xd"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    printf "${BLUE}[INFO]${NC} %s\n" "$1"
}

success() {
    printf "${GREEN}[SUCCESS]${NC} %s\n" "$1"
}

warn() {
    printf "${YELLOW}[WARN]${NC} %s\n" "$1"
}

error() {
    printf "${RED}[ERROR]${NC} %s\n" "$1" >&2
    exit 1
}

# 1. Detect Operating System
OS="$(uname -s)"
case "${OS}" in
    Linux*)     PLATFORM="linux" ;;
    Darwin*)    PLATFORM="darwin" ;;
    *)          error "Unsupported operating system: ${OS}. Please use install.ps1 on Windows." ;;
esac

# 2. Detect CPU Architecture
ARCH="$(uname -m)"
case "${ARCH}" in
    x86_64|amd64)   ARCH="amd64" ;;
    arm64|aarch64)  ARCH="arm64" ;;
    *)              error "Unsupported processor architecture: ${ARCH}" ;;
esac

# 3. Determine Version
if [ -n "${EXODECK_VERSION}" ]; then
    VERSION="${EXODECK_VERSION#v}"
    TAG="v${VERSION}"
else
    info "Fetching latest ExoDeck release information from GitHub..."
    LATEST_JSON=$(curl -sSf "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)
    if [ -n "${LATEST_JSON}" ]; then
        TAG=$(echo "${LATEST_JSON}" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/v\1/p' | head -n 1)
        VERSION="${TAG#v}"
    fi
    if [ -z "${TAG}" ] || [ -z "${VERSION}" ]; then
        error "Could not determine latest release version. Set EXODECK_VERSION manually (e.g. EXODECK_VERSION=1.0.0)."
    fi
fi

info "Installing ExoDeck ${TAG} for ${PLATFORM}-${ARCH}..."

# 4. Determine Installation Directory
if [ -n "${INSTALL_DIR}" ]; then
    TARGET_DIR="${INSTALL_DIR}"
elif [ "$(id -u)" -eq 0 ]; then
    TARGET_DIR="/usr/local/bin"
else
    TARGET_DIR="${HOME}/.local/bin"
fi

mkdir -p "${TARGET_DIR}" 2>/dev/null || {
    if command -v sudo >/dev/null 2>&1; then
        sudo mkdir -p "${TARGET_DIR}"
    else
        error "Cannot create directory ${TARGET_DIR}. Please specify a writable INSTALL_DIR."
    fi
}

# 5. Create Temporary Download Directory
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'exodeck')
cleanup() {
    rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

ARCHIVE_NAME="exodeck-${TAG}-${PLATFORM}-${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE_NAME}"
CHECKSUM_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.txt"

info "Downloading ${DOWNLOAD_URL}..."
curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_DIR}/${ARCHIVE_NAME}" || error "Failed to download ${DOWNLOAD_URL}"

# 6. Verify Checksum if available
if curl -fsSL "${CHECKSUM_URL}" -o "${TMP_DIR}/checksums.txt" 2>/dev/null; then
    info "Verifying SHA256 checksum..."
    EXPECTED_SHA=$(grep "${ARCHIVE_NAME}" "${TMP_DIR}/checksums.txt" | awk '{print $1}' || true)
    if [ -n "${EXPECTED_SHA}" ]; then
        if command -v sha256sum >/dev/null 2>&1; then
            ACTUAL_SHA=$(sha256sum "${TMP_DIR}/${ARCHIVE_NAME}" | awk '{print $1}')
        elif command -v shasum >/dev/null 2>&1; then
            ACTUAL_SHA=$(shasum -a 256 "${TMP_DIR}/${ARCHIVE_NAME}" | awk '{print $1}')
        else
            ACTUAL_SHA=""
            warn "Neither sha256sum nor shasum found; skipping checksum verification."
        fi

        if [ -n "${ACTUAL_SHA}" ]; then
            if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
                error "SHA256 checksum mismatch!\nExpected: ${EXPECTED_SHA}\nActual:   ${ACTUAL_SHA}"
            fi
            info "Checksum verified successfully."
        fi
    fi
fi

# 7. Check if xd is running and stop it before replacing
WAS_RUNNING=0
if pgrep -x "${BINARY}" >/dev/null 2>&1 || pidof "${BINARY}" >/dev/null 2>&1; then
    WAS_RUNNING=1
    info "Found running ExoDeck (${BINARY}) process. Stopping it before updating binary..."
    pkill -x "${BINARY}" 2>/dev/null || killall "${BINARY}" 2>/dev/null || true
    WAIT_COUNT=0
    while (pgrep -x "${BINARY}" >/dev/null 2>&1 || pidof "${BINARY}" >/dev/null 2>&1) && [ "${WAIT_COUNT}" -lt 10 ]; do
        sleep 0.5 2>/dev/null || sleep 1
        WAIT_COUNT=$((WAIT_COUNT + 1))
    done
    if pgrep -x "${BINARY}" >/dev/null 2>&1 || pidof "${BINARY}" >/dev/null 2>&1; then
        warn "Could not terminate running ${BINARY} process."
    else
        info "ExoDeck process stopped."
    fi
fi

# 8. Extract and Install Binary
info "Extracting ${BINARY}..."
tar -xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "${TMP_DIR}"

if [ -w "${TARGET_DIR}" ]; then
    mv "${TMP_DIR}/${BINARY}" "${TARGET_DIR}/${BINARY}"
    chmod 755 "${TARGET_DIR}/${BINARY}"
else
    info "Installing with sudo to ${TARGET_DIR}/${BINARY}..."
    sudo mv "${TMP_DIR}/${BINARY}" "${TARGET_DIR}/${BINARY}"
    sudo chmod 755 "${TARGET_DIR}/${BINARY}"
fi

# 9. macOS Gatekeeper Quarantine Removal
if [ "${PLATFORM}" = "darwin" ]; then
    xattr -d com.apple.quarantine "${TARGET_DIR}/${BINARY}" 2>/dev/null || true
fi

# 10. Desktop shortcut on Linux (only if not existing)
if [ "${PLATFORM}" = "linux" ] && [ -n "${HOME}" ]; then
    DESKTOP_DIR="${HOME}/.local/share/applications"
    DESKTOP_FILE="${DESKTOP_DIR}/exodeck.desktop"
    if [ ! -f "${DESKTOP_FILE}" ] && [ -d "${HOME}/.local/share" ]; then
        mkdir -p "${DESKTOP_DIR}" 2>/dev/null || true
        cat <<EOF > "${DESKTOP_FILE}" 2>/dev/null || true
[Desktop Entry]
Name=ExoDeck
Comment=Local-first personal cockpit and knowledge management
Exec=${TARGET_DIR}/${BINARY}
Terminal=false
Type=Application
Categories=Utility;Office;
EOF
        if [ -f "${DESKTOP_FILE}" ]; then
            chmod 644 "${DESKTOP_FILE}" 2>/dev/null || true
            success "Created desktop shortcut: ${DESKTOP_FILE}"
        fi
    elif [ -f "${DESKTOP_FILE}" ]; then
        info "Desktop shortcut already exists at ${DESKTOP_FILE}; skipping creation."
    fi
fi

# 11. Verify PATH
IN_PATH=0
case ":${PATH}:" in
    *:"${TARGET_DIR}":*) IN_PATH=1 ;;
esac

echo ""
success "ExoDeck (${TAG}) installed successfully to ${TARGET_DIR}/${BINARY}"
echo ""

if [ "${IN_PATH}" -eq 0 ]; then
    warn "${TARGET_DIR} is not in your current PATH environment variable."
    echo "To run '${BINARY}' directly from your terminal, add it to your PATH:"
    echo ""
    echo "  export PATH=\"${TARGET_DIR}:\$PATH\""
    echo ""
    echo "You can add that line to your ~/.bashrc, ~/.zshrc, or profile."
    echo ""
fi

info "Run '${BINARY}' to launch ExoDeck."
info "Default configuration & data directory: ~/.exodeck"
info "App will be available at: http://localhost:8000"
