#!/bin/bash

# === 1. 配置你的代理地址 (請修改這裡) ===
PROXY_URL="http://192.168.88.151:7897" 
# =====================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== RK3528 AI 代理修復版部署腳本 ===${NC}"

# 1. 設置 2GB Swap (針對 1G/4G 記憶體必做)
if [ ! -f /swapfile ]; then
    echo -e "${GREEN}[1/5] 正在設定 2GB Swap...${NC}"
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
else
    echo -e "${GREEN}[1/5] Swap 已存在。${NC}"
fi

# 2. 設定終端代理並安裝 Docker
export http_proxy=$PROXY_URL
export https_proxy=$PROXY_URL

echo -e "${GREEN}[2/5] 正在透過代理安裝 Docker...${NC}"
curl -fsSL https://docker.com -o get-docker.sh
if [ $? -ne 0 ]; then
    echo -e "${RED}錯誤: 無法下載 Docker 安裝腳本，請檢查代理地址！${NC}"
    exit 1
fi
sudo sh get-docker.sh

# 3. 配置 Docker 守護進程代理 (讓 Docker Pull 鏡像能過)
echo -e "${GREEN}[3/5] 配置 Docker Daemon 代理...${NC}"
sudo mkdir -p /etc/systemd/system/docker.service.d
echo "[Service]
Environment=\"HTTP_PROXY=$PROXY_URL\"
Environment=\"HTTPS_PROXY=$PROXY_URL\"" | sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf

sudo systemctl daemon-reload
sudo systemctl restart docker

# 4. 建立 Compose 檔案 (讓 Ollama 下載模型能過)
echo -e "${GREEN}[4/5] 配置 Docker Compose...${NC}"
mkdir -p ~/rk3528-ai && cd ~/rk3528-ai
cat << DOCKER > docker-compose.yml
services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: always
    ports:
      - "11434:11434"
    volumes:
      - ./ollama_data:/root/.ollama
    environment:
      - http_proxy=$PROXY_URL
      - https_proxy=$PROXY_URL
      - OLLAMA_KEEP_ALIVE=5m
DOCKER

# 5. 啟動並拉取模型
echo -e "${GREEN}[5/5] 啟動並下載 Qwen2.5-0.5B...${NC}"
sudo docker compose up -d
sleep 5
sudo docker exec -it ollama ollama pull qwen2.5:0.5b

echo -e "${BLUE}=========================================${NC}"
echo -e "${GREEN}部署完成！${NC}"
echo -e "對話指令: sudo docker exec -it ollama ollama run qwen2.5:0.5b"
echo -e "${BLUE}=========================================${NC}"