#!/bin/bash
# ------------------------------------------------------------------------------
# Gemini CLI Telegram — All-in-One Global Setup
# ------------------------------------------------------------------------------
set -e

# --- Colors ---
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Gemini CLI Telegram All-in-One Setup ===${NC}\n"

# Detect OS
if [ -f /etc/debian_version ]; then
    OS="debian"
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || [ -f /etc/fedora-release ]; then
    OS="rhel"
else
    OS="unknown"
fi

# 1. Install Node.js 20+ if missing
echo -e "${YELLOW}[1/3] Checking system dependencies...${NC}"
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

# 2. Install Gemini CLI Telegram globally
echo -e "${YELLOW}[2/3] Installing gemini-cli-telegram globally...${NC}"
npm install -g gemini-cli-telegram --legacy-peer-deps --loglevel=error

# 3. Run Interactive Setup (Gemini Auth + Telegram Token)
echo -e "${YELLOW}[3/3] Starting Configuration & Authentication...${NC}"
echo -e "${BLUE}This will guide you through Google Login and Telegram Bot setup.${NC}"
gemini-cli-telegram setup

# --- Completion ---
echo -e "\n${GREEN}=== Setup Complete! ===${NC}"
echo -e "To start the bot anytime, run:"
echo -e "${BLUE}  gemini-cli-telegram start${NC}"
echo -e "\nTo see logs:"
echo -e "${BLUE}  gemini-cli-telegram logs${NC}"
