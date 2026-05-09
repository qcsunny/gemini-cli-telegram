#!/bin/bash
# ------------------------------------------------------------------------------
# Gemini CLI Telegram — One-Click Setup Script
# ------------------------------------------------------------------------------
set -e

# --- Configuration ---
REPO_URL="https://github.com/ibidathoillah/gemini-cli-telegram.git"
INSTALL_DIR="$HOME/gemini-cli-telegram"

# --- Colors ---
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Gemini CLI Telegram Setup ===${NC}\n"

# 1. Check/Install Dependencies
echo -e "${YELLOW}[1/5] Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

if ! command -v git &> /dev/null; then
    echo "Installing Git..."
    sudo apt-get install -y git
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
