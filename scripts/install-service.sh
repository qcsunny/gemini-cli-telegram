#!/bin/bash

# --- UI Colors ---
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# --- Symbols ---
CHECK="✅"
PROGRESS="⏳"
INFO="ℹ️"
ERROR="❌"
QUESTION="❓"

# --- Helper: Confirmation Function ---
ask_confirmation() {
    echo -ne "${YELLOW}${QUESTION} $1 [y/N]: ${NC}"
    read -r response
    case "$response" in
        [yY][eE][sS]|[yY]) 
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

clear
echo -e "${BLUE}${BOLD}============================================${NC}"
echo -e "${BLUE}${BOLD}    OpenCode Bot Service Auto-Installer     ${NC}"
echo -e "${BLUE}${BOLD}============================================${NC}"

# --- Configuration ---
BOT_DIR=$(pwd)
NODE_PATH=$(which node)
SERVICE_NAME="opencode-bot"
USER_NAME=$(whoami)
OS_TYPE="$(uname)"

# --- Validation ---
if [ -z "$NODE_PATH" ]; then
    echo -e "${RED}${ERROR} Error: Node.js tidak ditemukan!${NC}"
    exit 1
fi

echo -e "${YELLOW}${PROGRESS} Mendeteksi Lingkungan...${NC}"
sleep 1
echo -e "  ${INFO} OS: ${BOLD}$OS_TYPE${NC}"
echo -e "  ${INFO} User: ${BOLD}$USER_NAME${NC}"
echo -e "  ${INFO} Path: ${BOLD}$BOT_DIR${NC}"
echo -e ""

if [ "$OS_TYPE" == "Darwin" ]; then
    # --- macOS Logic ---
    PLIST_PATH="$HOME/Library/LaunchAgents/com.$SERVICE_NAME.plist"
    
    if [ -f "$PLIST_PATH" ]; then
        echo -e "${YELLOW}${INFO} Service macOS sudah terdaftar.${NC}"
        if ! ask_confirmation "Ingin menimpa (replace) konfigurasi yang ada?"; then
            echo -e "${BLUE}${INFO} Instalasi dibatalkan oleh pengguna.${NC}"
            exit 0
        fi
    fi

    echo -e "${YELLOW}${PROGRESS} Mengonfigurasi macOS LaunchAgent...${NC}"
    cat << PLIST > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.$SERVICE_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$BOT_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$BOT_DIR/telegram-bot.log</string>
    <key>StandardErrorPath</key>
    <string>$BOT_DIR/telegram-bot.log</string>
</dict>
</PLIST>

    launchctl unload "$PLIST_PATH" 2>/dev/null
    launchctl load "$PLIST_PATH"
    echo -e "${GREEN}${CHECK} Service macOS berhasil diperbarui!${NC}"

elif [ "$OS_TYPE" == "Linux" ]; then
    # --- Linux Logic ---
    SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME.service"
    
    if [ -f "$SERVICE_PATH" ]; then
        echo -e "${YELLOW}${INFO} Service Linux sudah terdaftar di systemd.${NC}"
        if ! ask_confirmation "Ingin menimpa (replace) konfigurasi yang ada?"; then
            echo -e "${BLUE}${INFO} Instalasi dibatalkan oleh pengguna.${NC}"
            exit 0
        fi
    fi

    echo -e "${YELLOW}${PROGRESS} Mengonfigurasi Systemd Service (Membutuhkan sudo)...${NC}"
    sudo bash -c "cat << SYSTEMD > $SERVICE_PATH
[Unit]
Description=OpenCode Telegram Bot
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$BOT_DIR
ExecStart=$NODE_PATH dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:$BOT_DIR/telegram-bot.log
StandardError=append:$BOT_DIR/telegram-bot.log

[Install]
WantedBy=multi-user.target
SYSTEMD"

    # LidSwitch Check
    echo -e "${YELLOW}${PROGRESS} Memeriksa konfigurasi LidSwitch...${NC}"
    if grep -q "#HandleLidSwitch=suspend" /etc/systemd/logind.conf; then
        sudo sed -i 's/#HandleLidSwitch=suspend/HandleLidSwitch=ignore/g' /etc/systemd/logind.conf
        sudo systemctl restart systemd-logind
        echo -e "  ${CHECK} LidSwitch diatur ke ignore."
    else
        echo -e "  ${INFO} LidSwitch sudah dikonfigurasi sebelumnya."
    fi

    sudo systemctl daemon-reload
    sudo systemctl enable $SERVICE_NAME
    sudo systemctl restart $SERVICE_NAME
    echo -e "${GREEN}${CHECK} Service Linux berhasil diperbarui!${NC}"

else
    echo -e "${RED}${ERROR} OS tidak didukung.${NC}"
    exit 1
fi

# --- Final Summary ---
echo -e ""
echo -e "${BLUE}${BOLD}============================================${NC}"
echo -e "${GREEN}${BOLD}             SETUP BERHASIL!                ${NC}"
echo -e "${BLUE}${BOLD}============================================${NC}"
echo -e "${INFO} Status: ${GREEN}Bot berjalan di Background${NC}"
echo -e "${INFO} Reconnect: ${GREEN}Otomatis Aktif${NC}"
echo -e "${INFO} Log File: ${BOLD}$BOT_DIR/telegram-bot.log${NC}"
echo -e "${YELLOW}${BOLD} Ketik 'tail -f telegram-bot.log' untuk memantau.${NC}"
echo -e "${BLUE}${BOLD}============================================${NC}"
