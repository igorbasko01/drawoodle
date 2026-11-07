-- Players are identified per device: a public id plus a secret token (stored hashed).
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- A room: its players gather in the lobby, play a game together, and can play again.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES players(id),
  rounds INTEGER NOT NULL,
  pack TEXT NOT NULL,
  pace TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'playing', 'finished', 'closed')),
  -- The game being played, or the last one played.
  game_id TEXT,
  -- The last time a TV screen checked in.
  tv_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rooms_code ON rooms (code, updated_at);

-- Who is in a room, in join order.
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room_id, player_id)
);
CREATE INDEX room_members_player ON room_members (player_id, last_seen);

-- One game in a room. Where it is (round, phase, step) moves on when everyone is done or time runs out.
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seed INTEGER NOT NULL,
  -- Player ids in seat order (JSON array).
  seats TEXT NOT NULL,
  -- Each round's prompt for each seat (JSON array of arrays). Never sent to anyone but the artist until revealed.
  prompts TEXT NOT NULL,
  pack TEXT NOT NULL,
  pace TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('playing', 'over', 'ended')),
  round INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('draw', 'fib', 'vote', 'reveal', 'over')),
  -- Which drawing of the round is being shown: drawings are shown in the order of their (random) ids.
  step INTEGER NOT NULL,
  phase_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX games_room ON games (room_id, started_at);

-- A player's drawing for a round, as strokes (JSON).
CREATE TABLE drawings (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  round INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  strokes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (game_id, round, seat)
);

-- A fake title a player wrote for someone else's drawing.
CREATE TABLE fibs (
  game_id TEXT NOT NULL REFERENCES games(id),
  round INTEGER NOT NULL,
  artist INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, round, artist, seat)
);

-- A player's vote on a drawing: 'truth' or 'fib:<seat>'.
CREATE TABLE votes (
  game_id TEXT NOT NULL REFERENCES games(id),
  round INTEGER NOT NULL,
  artist INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  choice TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, round, artist, seat)
);
