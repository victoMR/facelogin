#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORTS=(5173 5174 8787)

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "Frenando puerto ${port}: ${pids}"
    kill ${pids} 2>/dev/null || true
    sleep 0.4
    pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      kill -9 ${pids} 2>/dev/null || true
    fi
  fi
}

echo "Parando facelogin…"
for port in "${PORTS[@]}"; do
  kill_port "$port"
done
sleep 0.4
for port in "${PORTS[@]}"; do
  kill_port "$port"
done

echo "Puertos libres. Arrancando de cero…"
cd "$ROOT"
exec npm run dev
