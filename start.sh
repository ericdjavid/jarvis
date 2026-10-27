#!/bin/zsh
# Lance JARVIS (backend + front) depuis TON terminal, pour que macOS
# accorde à Warp le contrôle des fenêtres (clic Orbit -> fenêtre Warp).
cd "$(dirname "$0")"
# .env wins over keys exported by ~/.zshrc (an old ELEVENLABS_API_KEY lives there).
set -a; source ./.env; set +a
# Stop every earlier JARVIS, not just whatever holds the ports (a server
# still shutting down holds no port but keeps its brain and mic alive).
pkill -f 'server.py --host' 2>/dev/null
lsof -ti tcp:8340 -ti tcp:5173 | xargs kill 2>/dev/null
sleep 2
pkill -9 -f 'server.py --host' 2>/dev/null
mkdir -p logs
.venv/bin/python server.py --host 127.0.0.1 2>&1 | tee logs/jarvis.log &
(cd frontend && npx vite --port 5173 --strictPort) &
sleep 4
open -a "Google Chrome" "http://localhost:5173/dashboard.html"
wait
