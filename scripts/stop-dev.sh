#!/bin/bash
set -euo pipefail

PORTS=(5173 5174 8787)

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "Frenando puerto ${port}: ${pids}"
    kill ${pids} 2>/dev/null || true
    sleep 0.3
    pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      kill -9 ${pids} 2>/dev/null || true
    fi
  else
    echo "Puerto ${port} ya estaba libre"
  fi
}

for port in "${PORTS[@]}"; do
  kill_port "$port"
done

echo "Todo frenado. Luego: npm run reset"
