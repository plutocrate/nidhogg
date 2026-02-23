# Nidhogg — Grotto Duel

Pixel-art 1v1 sword fighting game. Online multiplayer via WebSocket.

## Local development
```bash
npm install
npm start
# Open http://localhost:3000 in two browser tabs
```

## Deploy to Railway

1. Push to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. Done. Share the Railway URL with your opponent and open it in two tabs.

## Game modes
- **Online Duel** — 2 players on different machines/tabs via WebSocket
- **Local Duel** — 2 players on same keyboard (P1: WASD+J, P2: Arrows+Num0)
- **Tutorial** — practice vs AI

## Controls
| Action | P1 | P2 |
|--------|-----|-----|
| Move   | A / D | ← → |
| Jump   | W | ↑ |
| Crouch | S | ↓ |
| Attack | J | Num0 |

## Match rules
- 5 rounds — first to 3 wins
- One hit kills
- 3-2-1 countdown before each round
