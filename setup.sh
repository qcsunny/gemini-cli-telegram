#!/bin/bash
# ------------------------------------------------------------------------------
# Gemini CLI Telegram — One-Click Setup Script (Universal)
# ------------------------------------------------------------------------------
set -e

# --- Configuration ---
REPO_URL="https://github.com/ibidathoillah/gemini-cli-telegram.git"
INSTALL_DIR="$HOME/gemini-cli-telegram"

# --- Colors ---
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Gemini CLI Telegram Setup ===${NC}\n"

# Detect OS
if [ -f /etc/debian_version ]; then
    OS="debian"
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || [ -f /etc/fedora-release ]; then
    OS="rhel"
else
    OS="unknown"
fi

# 1. Check/Install Dependencies
echo -e "${YELLOW}[1/5] Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20..."
    if [ "$OS" == "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif [ "$OS" == "rhel" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo dnf install -y nodejs || sudo yum install -y nodejs
    else
        echo -e "${RED}Error: Unsupported OS. Please install Node.js 20+ manually.${NC}"
        exit 1
    fi
fi

if ! command -v git &> /dev/null; then
    echo "Installing Git..."
    if [ "$OS" == "debian" ]; then
        sudo apt-get update && sudo apt-get install -y git
    elif [ "$OS" == "rhel" ]; then
        sudo dnf install -y git || sudo yum install -y git
    else
        echo -e "${RED}Error: Unsupported OS. Please install Git manually.${NC}"
        exit 1
    fi
fi

# 2. Clone Repository
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}[2/5] Cloning repository...${NC}"
    git clone "$REPO_URL" "$INSTALL_DIR"
else
    echo -e "${YELLOW}[2/5] Repository already exists, pulling latest...${NC}"
    cd "$INSTALL_DIR" && git pull
fi

cd "$INSTALL_DIR"

# 3. Install NPM Packages
echo -e "${YELLOW}[3/5] Installing dependencies...${NC}"
npm install

# 4. Build Project
echo -e "${YELLOW}[4/5] Building project...${NC}"
npm run build

# 5. Interactive Setup
echo -e "${YELLOW}[5/5] Starting Interactive Setup...${NC}"
node dist/cli.js setup

# --- Completion ---
echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
echo -e "You can now start the bot using:"
echo -e "${BLUE}  npm start${NC}"
echo -e "\nTo install as a background service (auto-restart):"
echo -e "${BLUE}  sudo ./scripts/install-service.sh${NC}"
echo -e "\n${GREEN}Ready to chat!${NC}"
