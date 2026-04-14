const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'game-state.json');

// --- Game State ---
let state = {
  phase: 'registration', // registration | voting | reveal | coordination | ended
  currentRound: 0,
  teams: {},            // teamId -> { name, socketId, connected }
  roundChoices: {},     // teamId -> 'coast' | 'mountains'
  history: [],          // array of round result objects
  teamOrder: []         // ordered list of team IDs for consistent display
};

// --- Persistence ---
function saveState() {
  try {
    const serializable = { ...state };
    fs.writeFileSync(STATE_FILE, JSON.stringify(serializable, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = data;
      // Clear socket connections on reload
      for (const id in state.teams) {
        state.teams[id].socketId = null;
        state.teams[id].connected = false;
      }
      console.log('Restored game state from file.');
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
}

loadState();

// --- Scoring ---
function calculateScores(choices, totalTeams) {
  const teamIds = Object.keys(choices);
  let coastTeams = [];
  let mountainsTeams = [];

  for (const id of teamIds) {
    if (choices[id] === 'coast') coastTeams.push(id);
    else mountainsTeams.push(id);
  }

  const c = coastTeams.length;
  const m = mountainsTeams.length;
  const scores = {};

  if (m === 0) {
    // All Coast: +1 each
    for (const id of coastTeams) scores[id] = 1;
  } else if (c === 0) {
    // All Mountains: -1 each
    for (const id of mountainsTeams) scores[id] = -1;
  } else if (c >= m) {
    // Coast is majority or tied: Coast loses m, Mountains gains c
    for (const id of coastTeams) scores[id] = -m;
    for (const id of mountainsTeams) scores[id] = c;
  } else {
    // Mountains is majority: Coast gains m, Mountains loses c
    for (const id of coastTeams) scores[id] = m;
    for (const id of mountainsTeams) scores[id] = -c;
  }

  return scores;
}

function getCumulativeScores() {
  const cumulative = {};
  for (const id of state.teamOrder) {
    cumulative[id] = 0;
  }
  for (const round of state.history) {
    for (const id in round.scores) {
      if (cumulative[id] !== undefined) {
        cumulative[id] += round.scores[id];
      }
    }
  }
  return cumulative;
}

function getCollectiveTotal() {
  const cumulative = getCumulativeScores();
  return Object.values(cumulative).reduce((a, b) => a + b, 0);
}

function getCollectiveMax() {
  return state.teamOrder.length * 10;
}

function getMaxOneTeam() {
  return (state.teamOrder.length - 1) * 10;
}

// Coordination rounds happen AFTER rounds 3 and 7
function isCoordinationRound(roundNum) {
  return roundNum === 3 || roundNum === 7;
}

// --- Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- QR Code endpoint ---
app.get('/api/qr', async (req, res) => {
  const baseUrl = req.query.url || `${req.protocol}://${req.get('host')}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(baseUrl, {
      width: 400,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' }
    });
    res.json({ qr: qrDataUrl, url: baseUrl });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// --- API for state (backup) ---
app.get('/api/state', (req, res) => {
  res.json({
    phase: state.phase,
    currentRound: state.currentRound,
    teams: Object.fromEntries(
      state.teamOrder.map(id => [id, { name: state.teams[id].name, connected: state.teams[id].connected }])
    ),
    history: state.history,
    cumulative: getCumulativeScores(),
    collectiveTotal: getCollectiveTotal(),
    collectiveMax: getCollectiveMax(),
    maxOneTeam: getMaxOneTeam(),
    submittedThisRound: Object.keys(state.roundChoices)
  });
});

// --- Reset endpoint ---
app.post('/api/reset', (req, res) => {
  state = {
    phase: 'registration',
    currentRound: 0,
    teams: {},
    roundChoices: {},
    history: [],
    teamOrder: []
  };
  saveState();
  io.emit('state-update', getPublicState());
  io.emit('facilitator-update', getFacilitatorState());
  res.json({ ok: true });
});

// --- Socket.io ---
function getPublicState() {
  return {
    phase: state.phase,
    currentRound: state.currentRound,
    teams: Object.fromEntries(
      state.teamOrder.map(id => [id, {
        name: state.teams[id].name,
        connected: state.teams[id].connected
      }])
    ),
    teamOrder: state.teamOrder,
    submittedThisRound: Object.keys(state.roundChoices),
    history: state.history,
    cumulative: getCumulativeScores(),
    collectiveTotal: getCollectiveTotal(),
    collectiveMax: getCollectiveMax(),
    maxOneTeam: getMaxOneTeam()
  };
}

function getFacilitatorState() {
  return {
    ...getPublicState(),
    roundChoices: state.roundChoices,  // facilitator can see choices
    allTeams: Object.fromEntries(
      state.teamOrder.map(id => [id, state.teams[id]])
    )
  };
}

function doReveal() {
  if (state.phase !== 'voting') return;

  const scores = calculateScores(state.roundChoices, state.teamOrder.length);
  const roundResult = {
    round: state.currentRound,
    choices: { ...state.roundChoices },
    scores: scores
  };
  state.history.push(roundResult);
  state.phase = 'reveal';
  saveState();

  io.emit('round-reveal', roundResult);
  io.emit('state-update', getPublicState());
  io.emit('facilitator-update', getFacilitatorState());

  for (const id of state.teamOrder) {
    const sid = state.teams[id].socketId;
    if (sid) io.to(sid).emit('team-state', getTeamState(id));
  }
}

function getTeamState(teamId) {
  return {
    phase: state.phase,
    currentRound: state.currentRound,
    teamId: teamId,
    teamName: state.teams[teamId]?.name,
    hasSubmitted: !!state.roundChoices[teamId],
    myChoice: state.roundChoices[teamId] || null,
    // Only show own scores during reveal
    history: state.history.map(r => ({
      round: r.round,
      myChoice: r.choices[teamId],
      myScore: r.scores[teamId],
      // Full results visible after reveal
      choices: r.choices,
      scores: r.scores
    })),
    cumulative: getCumulativeScores()[teamId] || 0
  };
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // --- Team Registration ---
  socket.on('register-team', (data, callback) => {
    if (state.phase !== 'registration') {
      return callback?.({ error: 'Registration is closed. The game has started.' });
    }
    const name = (data.name || '').trim();
    if (!name) {
      return callback?.({ error: 'Please enter a team name.' });
    }
    // Check for duplicate names
    const nameTaken = state.teamOrder.some(id =>
      state.teams[id].name.toLowerCase() === name.toLowerCase()
    );
    if (nameTaken) {
      return callback?.({ error: 'That name is taken. Pick another.' });
    }
    const teamId = 'team_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    state.teams[teamId] = {
      name: name,
      socketId: socket.id,
      connected: true
    };
    state.teamOrder.push(teamId);
    socket.teamId = teamId;
    socket.join('teams');

    saveState();
    callback?.({ ok: true, teamId: teamId });

    io.emit('state-update', getPublicState());
    io.emit('facilitator-update', getFacilitatorState());
  });

  // --- Team Reconnection ---
  socket.on('rejoin-team', (data, callback) => {
    const teamId = data.teamId;
    if (state.teams[teamId]) {
      state.teams[teamId].socketId = socket.id;
      state.teams[teamId].connected = true;
      socket.teamId = teamId;
      socket.join('teams');
      saveState();
      callback?.({ ok: true, teamName: state.teams[teamId].name });
      socket.emit('team-state', getTeamState(teamId));
      io.emit('state-update', getPublicState());
      io.emit('facilitator-update', getFacilitatorState());
    } else {
      callback?.({ error: 'Team not found.' });
    }
  });

  // --- Team Choice Submission ---
  socket.on('submit-choice', (data, callback) => {
    if (state.phase !== 'voting') {
      return callback?.({ error: 'Not accepting choices right now.' });
    }
    const teamId = socket.teamId || data.teamId;
    if (!teamId || !state.teams[teamId]) {
      return callback?.({ error: 'Team not recognized.' });
    }
    const choice = data.choice;
    if (choice !== 'coast' && choice !== 'mountains') {
      return callback?.({ error: 'Invalid choice.' });
    }
    state.roundChoices[teamId] = choice;
    saveState();
    callback?.({ ok: true });

    // Notify display of submission (without revealing choice)
    io.emit('state-update', getPublicState());
    io.emit('facilitator-update', getFacilitatorState());

    // Send updated team state
    socket.emit('team-state', getTeamState(teamId));

    // Check if all teams have submitted — auto-reveal
    const allSubmitted = state.teamOrder.every(id => state.roundChoices[id]);
    if (allSubmitted) {
      doReveal();
    }
  });

  // --- Facilitator: manual choice entry ---
  socket.on('facilitator-submit-choice', (data) => {
    if (state.phase !== 'voting') return;
    const { teamId, choice } = data;
    if (!state.teams[teamId]) return;
    if (choice !== 'coast' && choice !== 'mountains') return;

    state.roundChoices[teamId] = choice;
    saveState();

    io.emit('state-update', getPublicState());
    io.emit('facilitator-update', getFacilitatorState());

    // Update the team's phone if connected
    const teamSocket = state.teams[teamId].socketId;
    if (teamSocket) {
      io.to(teamSocket).emit('team-state', getTeamState(teamId));
    }

    // Check if all teams have submitted — auto-reveal
    const allSubmitted = state.teamOrder.every(id => state.roundChoices[id]);
    if (allSubmitted) {
      doReveal();
    }
  });

  // --- Facilitator: Start Game ---
  socket.on('start-game', () => {
    if (state.phase !== 'registration') return;
    if (state.teamOrder.length < 2) return; // need at least 2 teams

    state.phase = 'voting';
    state.currentRound = 1;
    state.roundChoices = {};
    saveState();

    io.emit('state-update', getPublicState());
    io.emit('facilitator-update', getFacilitatorState());
    // Update all team phones
    for (const id of state.teamOrder) {
      const sid = state.teams[id].socketId;
      if (sid) io.to(sid).emit('team-state', getTeamState(id));
    }
  });

  // --- Facilitator: Reveal Results ---
  socket.on('reveal-results', () => {
    doReveal();
  });

  // --- Facilitator: Next Round ---
  socket.on('next-round', () => {
    if (state.phase !== 'reveal' && state.phase !== 'coordination') return;

    if (state.currentRound >= 10) {
      state.phase = 'ended';
      saveState();
      io.emit('state-update', getPublicState());
      io.emit('facilitator-update', getFacilitatorState());
      for (const id of state.teamOrder) {
        const sid = state.teams[id].socketId;
        if (sid) io.to(sid).emit('team-state', getTeamState(id));
      }
      return;
    }

    // Check if this round triggers a coordination pause
    if (state.phase === 'reveal' && isCoordinationRound(state.currentRound)) {
      state.phase = 'coordination';
      saveState();
      io.emit('state-update', getPublicState());
      io.emit('facilitator-update', getFacilitatorState());
      return;
    }

    // Advance to next voting round
    state.currentRound += 1;
    state.phase = 'voting';
    state.roundChoices = {};
    saveState();

    io.emit('state-update', getPublicState());
    io.emit('facilitator-update', getFacilitatorState());
    for (const id of state.teamOrder) {
      const sid = state.teams[id].socketId;
      if (sid) io.to(sid).emit('team-state', getTeamState(id));
    }
  });

  // --- Facilitator: End Game ---
  socket.on('end-game', () => {
    state.phase = 'ended';
    saveState();
    io.emit('state-update', getPublicState());
    io.emit('facilitator-update', getFacilitatorState());
    for (const id of state.teamOrder) {
      const sid = state.teams[id].socketId;
      if (sid) io.to(sid).emit('team-state', getTeamState(id));
    }
  });

  // --- Facilitator: Show Rules ---
  socket.on('show-rules', () => {
    io.emit('show-rules');
  });

  // --- Facilitator: Remove Team ---
  socket.on('remove-team', (data) => {
    if (state.phase !== 'registration') return;
    const { teamId } = data;
    if (state.teams[teamId]) {
      const sid = state.teams[teamId].socketId;
      if (sid) io.to(sid).emit('removed');
      delete state.teams[teamId];
      state.teamOrder = state.teamOrder.filter(id => id !== teamId);
      delete state.roundChoices[teamId];
      saveState();
      io.emit('state-update', getPublicState());
      io.emit('facilitator-update', getFacilitatorState());
    }
  });

  // --- Join as display ---
  socket.on('join-display', () => {
    socket.join('display');
    socket.emit('state-update', getPublicState());
  });

  // --- Join as facilitator ---
  socket.on('join-facilitator', () => {
    socket.join('facilitator');
    socket.emit('facilitator-update', getFacilitatorState());
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    if (socket.teamId && state.teams[socket.teamId]) {
      state.teams[socket.teamId].connected = false;
      state.teams[socket.teamId].socketId = null;
      saveState();
      io.emit('state-update', getPublicState());
      io.emit('facilitator-update', getFacilitatorState());
    }
  });
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`\n  Game Theory Exercise Tool`);
  console.log(`  ========================`);
  console.log(`  Server running on port ${PORT}`);
  console.log(`\n  Team join page:     http://localhost:${PORT}/`);
  console.log(`  Display (project):  http://localhost:${PORT}/display.html`);
  console.log(`  Facilitator panel:  http://localhost:${PORT}/facilitator.html`);
  console.log(`\n  Teams registered: ${state.teamOrder.length}`);
  console.log(`  Current phase: ${state.phase}`);
  if (state.currentRound > 0) console.log(`  Current round: ${state.currentRound}`);
  console.log('');
});
