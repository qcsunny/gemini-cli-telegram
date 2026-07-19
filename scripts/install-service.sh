#!/bin/bash

# ====================================================
#   OPENCODE TELEGRAM BOT - ALL-IN-ONE MANAGER
# ====================================================
# OS Support: macOS (Launchd) & Linux (Systemd)
# Features: Scan, Install, Auto-Reconnect, Lid-Closed
# ====================================================

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
SCAN="🔍"
BOT="🤖"

# --- Configuration ---
SERVICE_NAME="gemini-telegram"
NODE_PATH=$(which node)
OS_TYPE="$(uname)"

# --- 1. SCANNER FUNCTION (Cari dari PS) ---
scan_instances() {
    echo -e "${BLUE}${BOLD}${SCAN} Memindai Bot yang sedang berjalan...${NC}"
    printf "${BOLD}%-8s %-12s %-20s %-8s %-10s${NC}\n" "PID" "PORT" "BOT USERNAME" "STATUS" "PATH"
    echo "--------------------------------------------------------------------"

    local found=0
    # Cari proses node yang menjalankan bot
    ps aux | grep "node" | grep "dist/cli.js" | grep -v grep | awk '{print $2}' | while read pid; do
        found=1
        # Cari Working Directory (CWD)
        if [ "$OS_TYPE" == "Darwin" ]; then
            CWD=$(lsof -p $pid | grep cwd | awk '{print $9}')
        else
            CWD=$(readlink -f /proc/$pid/cwd)
        fi

        if [ -f "$CWD/.env" ]; then
            TOKEN=$(grep "TELEGRAM_BOT_TOKEN" "$CWD/.env" | cut -d'=' -f2 | tr -d ' "')
            PORT=$(grep "OPENCODE_API_URL" "$CWD/.env" | sed -E 's/.*:([0-9]+).*/\1/')
            [ -z "$PORT" ] && PORT="4096"

            # Ambil Username Bot via Telegram API (Timeout 2s)
            USERNAME=$(curl -s --max-time 2 "https://api.telegram.org/bot$TOKEN/getMe" | grep -oP '(?<="username":")[^"]*' || echo "Unknown")
            
            # Cek Port Status
            PORT_STATUS="${GREEN}ACTIVE${NC}"
            
            printf "%-8s %-12s %-20s %-8s %-10s\n" "$pid" "$PORT" "@$USERNAME" "$PORT_STATUS" "$CWD"
        fi
    done
    
    if [ $found -eq 0 ]; then
        echo -e "  ${YELLOW}Tidak ada instance bot yang ditemukan sedang berjalan.${NC}"
    fi
    echo ""
}

# --- 2. INSTALL/UPDATE FUNCTION ---
run_setup() {
    echo -e "${BLUE}${BOLD}${PROGRESS} Memulai Konfigurasi...${NC}"
    
    # Smart Token Handling
    local BOT_TOKEN=""
    if [ -f ".env" ]; then
        EXISTING_TOKEN=$(grep "TELEGRAM_BOT_TOKEN" .env | cut -d'=' -f2 | tr -d ' "')
        if [ ! -z "$EXISTING_TOKEN" ]; then
            echo -e "${GREEN}${CHECK} Menemukan Token di .env: ${BOLD}${EXISTING_TOKEN:0:5}...${EXISTING_TOKEN: -5}${NC}"
            echo -ne "${YELLOW}${INFO} Tekan ENTER untuk pakai token ini, atau masukkan token baru: ${NC}"
            read NEW_TOKEN
            if [ -z "$NEW_TOKEN" ]; then
                BOT_TOKEN=$EXISTING_TOKEN
            else
                BOT_TOKEN=$NEW_TOKEN
            fi
        fi
    fi

    if [ -z "$BOT_TOKEN" ]; then
        echo -ne "${BLUE}${BOT} Masukkan Telegram Bot Token: ${NC}"
        read BOT_TOKEN
    fi

    # Simpan ke .env
    if [ ! -f ".env" ]; then
        cp .env.example .env 2>/dev/null || touch .env
    fi
    
    # Update token di .env (Handle both MacOS and Linux sed)
    if [ "$OS_TYPE" == "Darwin" ]; then
        if grep -q "TELEGRAM_BOT_TOKEN" .env; then
            sed -i '' "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$BOT_TOKEN/" .env
        else
            echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" >> .env
        fi
    else
        if grep -q "TELEGRAM_BOT_TOKEN" .env; then
            sed -i "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$BOT_TOKEN/" .env
        else
            echo "TELEGRAM_BOT_TOKEN=$BOT_TOKEN" >> .env
        fi
    fi

    # --- Service Installation ---
    local BOT_DIR=$(pwd)
    local USER_NAME=$(whoami)

    if [ "$OS_TYPE" == "Darwin" ]; then
        # macOS LaunchAgent
        PLIST_PATH="$HOME/Library/LaunchAgents/com.$SERVICE_NAME.plist"
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
        <string>dist/cli.js</string>
        <string>start</string>
        <string>--live</string>
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
        echo -e "${GREEN}${CHECK} macOS Service Aktif (Auto-Reconnect ON)${NC}"
        echo -e "${YELLOW}${INFO} Jalankan 'caffeinate -d &' agar Mac tidak tidur saat lid ditutup.${NC}"

    elif [ "$OS_TYPE" == "Linux" ]; then
        # Linux Systemd
        SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME.service"
        sudo bash -c "cat << SYSTEMD > $SERVICE_PATH
[Unit]
Description=Gemini Telegram Bot Service
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$BOT_DIR
ExecStart=$NODE_PATH dist/cli.js start --live
Restart=always
RestartSec=10
# The bot writes its own logs to daemon.log (LOG_PATH) inside the process, so
# do NOT redirect stdout/stderr to a log file here — doing so would make systemd
# hold a separate file descriptor to a different inode than the on-disk log,
# causing logs to silently disappear after the log is rotated/recreated.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SYSTEMD"
        # LidSwitch Config
        sudo sed -i 's/#HandleLidSwitch=suspend/HandleLidSwitch=ignore/g' /etc/systemd/logind.conf
        sudo systemctl restart systemd-logind
        sudo systemctl daemon-reload
        sudo systemctl enable $SERVICE_NAME
        sudo systemctl restart $SERVICE_NAME
        echo -e "${GREEN}${CHECK} Linux Service Aktif & LidSwitch diatur ke Ignore${NC}"
    fi
}

# --- MAIN LOGIC ---
clear
echo -e "${BLUE}${BOLD}====================================================${NC}"
echo -e "${BLUE}${BOLD}     OPENCODE BOT & SERVICE ALL-IN-ONE MANAGER      ${NC}"
echo -e "${BLUE}${BOLD}====================================================${NC}"

# 1. Jalankan Scanner
scan_instances

# 2. Tawarkan Menu
echo -e "${BOLD}Pilih Tindakan:${NC}"
echo -e "  ${BOLD}[1]${NC} Install / Update Service (Re-run Setup)"
echo -e "  ${BOLD}[2]${NC} Matikan Semua Bot (Kill Processes)"
echo -e "  ${BOLD}[3]${NC} Lihat Log Bot (Tail)"
echo -e "  ${BOLD}[4]${NC} Keluar"
echo -ne "\n${YELLOW}Masukkan pilihan (1-4): ${NC}"
read choice

case $choice in
    1)
        run_setup
        ;;
    2)
        echo -e "${RED}${PROGRESS} Mematikan semua instance bot...${NC}"
        ps aux | grep "node" | grep "dist/cli.js" | grep -v grep | awk '{print $2}' | xargs kill -9 2>/dev/null
        echo -e "${GREEN}${CHECK} Semua bot telah dimatikan.${NC}"
        ;;
    3)
        echo -e "${BLUE}${INFO} Menampilkan log (Tekan Ctrl+C untuk berhenti):${NC}"
        tail -f telegram-bot.log
        ;;
    4)
        echo "Keluar..."
        exit 0
        ;;
    *)
        echo -e "${RED}${ERROR} Pilihan tidak valid.${NC}"
        ;;
esac

echo -e "\n${GREEN}${BOLD}Operasi Selesai!${NC}"
