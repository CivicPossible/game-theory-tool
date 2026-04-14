# Win As Much As You Can — Game Theory Exercise Tool

A real-time facilitation tool for running "Win As Much As You Can" game theory exercises at workshops and conferences.

## Quick Start (Local)

```bash
npm install
npm start
```

Then open:
- **Team join page:** http://localhost:3000/
- **Display (project on screen):** http://localhost:3000/display.html
- **Facilitator panel:** http://localhost:3000/facilitator.html

## Deploy to Railway (Recommended)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app), sign in with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Select your repo — Railway auto-detects Node.js and deploys
5. In Settings, ensure the start command is `npm start`
6. Railway gives you a public URL (e.g., `your-app.up.railway.app`)

That URL is what you share with participants. The display screen and facilitator panel use the same domain with different paths.

## How It Works

### Three Views

| URL | Who uses it | Purpose |
|-----|------------|---------|
| `/` | Participants (phones) | Join game, submit choices |
| `/display.html` | Projected screen | Scoreboard, QR code, results |
| `/facilitator.html` | Facilitator (tablet/laptop) | Control game flow |

### Game Flow

1. Open `/display.html` on the projected screen — it shows a QR code
2. Open `/facilitator.html` on your device
3. Teams scan the QR code and enter their team name
4. When all teams are in, hit "Start Game" on the facilitator panel
5. Each round: teams vote on their phones, you reveal results
6. After rounds 3 and 7: coordination rounds auto-trigger
7. After round 10: game over screen shows collective results

### Fallback Mode

If a phone dies or wifi is spotty, you can enter any team's choice directly from the facilitator panel. The game doesn't care how a choice gets entered.

## State Persistence

Game state is saved to `game-state.json` on every change. If the server restarts, it picks up where it left off. Use the "Reset Game" button on the facilitator panel to start fresh.

## Running Locally as Backup

If conference wifi fails completely, you can run the server on your laptop. Participants connect to your laptop's IP address on the local network:

```bash
# Find your IP
# Mac: ifconfig | grep "inet "
# Windows: ipconfig

# Participants visit: http://YOUR_IP:3000/
```

## Environment Variables

- `PORT` — Server port (default: 3000)
