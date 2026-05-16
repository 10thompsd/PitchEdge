require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

const server = http.createServer(app);

// ── Auth ──────────────────────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const AUTH_TOKEN = 'pitchedge_auth';

function isAuthenticated(req) {
  return req.cookies[AUTH_TOKEN] === DASHBOARD_PASSWORD;
}

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>PitchEdge Login</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d0f12; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: 'DM Mono', monospace; }
    .box { background: #13161b; border: 1px solid #1e2229; border-radius: 12px; padding: 40px; width: 320px; }
    .logo { color: #00e5a0; font-size: 14px; margin-bottom: 28px; display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; background: #00e5a0; border-radius: 50%; box-shadow: 0 0 8px #00e5a0; }
    label { display: block; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    input { width: 100%; background: #0d0f12; border: 1px solid #1e2229; color: #e8eaed; font-family: 'DM Mono', monospace; font-size: 13px; padding: 10px 14px; border-radius: 6px; outline: none; margin-bottom: 16px; }
    input:focus { border-color: #00e5a0; }
    button { width: 100%; background: #00e5a0; color: #0d0f12; font-family: 'DM Mono', monospace; font-size: 13px; font-weight: 500; padding: 11px; border: none; border-radius: 6px; cursor: pointer; }
    .error { color: #ff4d4d; font-size: 12px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="logo"><div class="dot"></div>PitchEdge</div>
    ${req.query.error ? '<div class="error">Incorrect password</div>' : ''}
    <form method="POST" action="/login">
      <label>Password</label>
      <input type="password" name="password" autofocus />
      <button type="submit">Enter</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    res.cookie(AUTH_TOKEN, DASHBOARD_PASSWORD, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.redirect('/dashboard');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie(AUTH_TOKEN);
  res.redirect('/login');
});

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        rep_name TEXT,
        industry TEXT DEFAULT 'Estate Agency',
        scenario TEXT,
        score INTEGER,
        duration_seconds INTEGER,
        objections_used JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Database ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
})();

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!isAuthenticated(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/api/calls', async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const result = await pool.query('SELECT * FROM calls ORDER BY created_at DESC LIMIT 200');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── IVR Menu ──────────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="/voice/route" method="POST" numDigits="1" timeout="10">
    <Say voice="Polly.Amy">
      Hello and welcome to PitchEdge. Your call will be recorded for training and monitoring purposes.
      Please select your training scenario.
      Press 1 for Property Buyer training.
      Press 2 for Vendor and Competing Agent training.
    </Say>
  </Gather>
  <Say voice="Polly.Amy">We did not receive your selection. Please call back and try again.</Say>
</Response>`);
});

// ── IVR Routing ───────────────────────────────────────────────────────────────
app.post('/voice/route', (req, res) => {
  const digit = req.body.Digits;
  const agentMap = {
    '1': { id: process.env.ELEVENLABS_AGENT_ID_BUYER,  scenario: 'Property Buyer' },
    '2': { id: process.env.ELEVENLABS_AGENT_ID_VENDOR, scenario: 'Vendor / Competing Agent' },
  };

  const selected = agentMap[digit];

  if (!selected) {
    res.type('text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Invalid selection. Please call back and try again.</Say>
</Response>`);
  }

  const wsUrl = `wss://${req.headers.host}/media-stream?scenario=${encodeURIComponent(selected.scenario)}&agentId=${encodeURIComponent(selected.id)}`;

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy">Connecting you to your sales trainer now. Good luck.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
});

app.get('/', (req, res) => res.send('PitchEdge server running'));

// ── WebSocket — Twilio <-> ElevenLabs ─────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs, req) => {
  console.log('Twilio connected');

  const urlParams = new URL(req.url, 'http://localhost');
  const agentId   = urlParams.get('agentId') || process.env.ELEVENLABS_AGENT_ID;
  const scenario  = urlParams.get('scenario') || 'Unknown';

  let streamSid = null;
  const callStart = Date.now();

  const elevenWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
  );

  elevenWs.on('open', () => console.log(`ElevenLabs connected — scenario: ${scenario}`));

  elevenWs.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'audio' && streamSid) {
      const payload = {
        event: 'media',
        streamSid,
        media: { payload: msg.audio_event?.audio_base_64 }
      };
      if (payload.media.payload) twilioWs.send(JSON.stringify(payload));
    }
  });

  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.event === 'start') streamSid = msg.start.streamSid;
    if (msg.event === 'media' && elevenWs?.readyState === WebSocket.OPEN) {
      elevenWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
    }
  });

  twilioWs.on('close', async () => {
    console.log('Call ended');
    elevenWs?.close();
    const durationSeconds = Math.round((Date.now() - callStart) / 1000);
    try {
      await pool.query(
        `INSERT INTO calls (rep_name, industry, scenario, duration_seconds) VALUES ($1, $2, $3, $4)`,
        ['Unknown', 'Estate Agency', scenario, durationSeconds]
      );
      console.log('Call logged');
    } catch (e) {
      console.error('Failed to log call:', e.message);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PitchEdge running on port ${PORT}`));