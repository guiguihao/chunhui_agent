#!/bin/bash
PROXY="http://192.168.88.151:7897"

echo "配置 Docker 代理..."
sudo mkdir -p /etc/systemd/system/docker.service.d
echo "[Service]
Environment=\"HTTP_PROXY=$PROXY\"
Environment=\"HTTPS_PROXY=$PROXY\"" | sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf

sudo systemctl daemon-reload
sudo systemctl restart docker

echo "部署 Ollama..."
mkdir -p ~/rk3528-ai && cd ~/rk3528-ai
cat << DOCKER > docker-compose.yml
services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: always
    environment:
      - http_proxy=$PROXY
      - https_proxy=$PROXY
      - OLLAMA_KEEP_ALIVE=5m
    ports:
      - "11434:11434"
    volumes:
      - ./ollama_data:/root/.ollama
DOCKER

sudo docker compose up -d
echo "等待容器啟動..."
sleep 10
sudo docker exec -it ollama ollama pull qwen2.5:0.5b