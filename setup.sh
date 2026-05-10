#!/bin/bash
# ------------------------------------------------------------------------------
# Gemini CLI Telegram — In-Place Setup Script
# ------------------------------------------------------------------------------
set -e

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
echo -e "${YELLOW}[1/5] Checking system dependencies...${NC}"

if ! command -v git &> /dev/null; then
    echo "Installing Git..."
    if [ "$OS" == "debian" ]; then
        sudo apt-get update && sudo apt-get install -y git
    elif [ "$OS" == "rhel" ]; then
        sudo dnf install -y git || sudo yum install -y git
    fi
fi

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

# 2. Clone/Prepare Project
if [ ! -f "package.json" ]; then
    if [ -d "gemini-cli-telegram" ]; then
        echo -e "${YELLOW}[2/5] Directory exists, entering...${NC}"
        cd gemini-cli-telegram
    else
        echo -e "${YELLOW}[2/5] Cloning repository...${NC}"
        git clone https://github.com/ibidathoillah/gemini-cli-telegram.git
        cd gemini-cli-telegram
    fi
else
    echo -e "${YELLOW}[2/5] Using current directory...${NC}"
fi

# 3. Install NPM Packages
echo -e "${YELLOW}[3/5] Installing project dependencies...${NC}"
npm install --legacy-peer-deps

# 4. Build Project
echo -e "${YELLOW}[4/5] Building project...${NC}"
npm run build

# 5. Interactive Setup
echo -e "${YELLOW}[5/5] Starting Interactive Wizard...${NC}"
node dist/cli.js setup

# --- Completion ---
echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
echo -e "Start the bot:"
echo -e "${BLUE}  npm start${NC}"
echo -e "\nInstall as system service:"
echo -e "${BLUE}  sudo ./scripts/install-service.sh${NC}"
