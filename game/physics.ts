// Coordenadas do estádio Classic oficial, transladadas de (-420..420,
// -200..200) para um canvas positivo. A área de grama é 740 x 340.
export const WORLD_WIDTH = 840;
export const WORLD_HEIGHT = 400;
export const FIELD = { left: 50, right: 790, top: 30, bottom: 370, goalTop: 136, goalBottom: 264, goalDepth: 30 };
export const PLAYER_BOUNDS = { left: 0, right: 840, top: 0, bottom: 400 };

export type Team = "blue" | "red";
export type InputState = { up: boolean; down: boolean; left: boolean; right: boolean; kick: boolean };
export type PhysicsSettings = { acceleration: number; maxSpeed: number; kickForce: number; playerGrip: number };
export type PlayerAction = { kickCooldown: number; kickHeld: boolean; kickFlash: number };
export type Disc = {
  id: string; team: Team | "ball"; x: number; y: number; vx: number; vy: number;
  radius: number; mass: number; number?: number; controlled?: boolean;
};
export type GameWorld = {
  discs: Disc[];
  scoreBlue: number;
  scoreRed: number;
  actions: Record<string, PlayerAction>;
  spawnPositions: Record<string, [number, number]>;
  goalFlash: number;
  lastGoal: Team | null;
  kickoffActive: boolean;
};
export type MatchPlayer = { id: string; team: Team; number: number };

// Conversão aproximada da física padrão do HaxBall para pixels/segundo.
// No original: damping 0.96, acceleration 0.1, kickingAcceleration 0.07,
// kickStrength 5 e damping da bola 0.99 por tick de 60 Hz.
export const DEFAULT_PHYSICS: PhysicsSettings = { acceleration: 360, maxSpeed: 150, kickForce: 300, playerGrip: -Math.log(0.96) * 60 };
export const IDLE_INPUT: InputState = { up: false, down: false, left: false, right: false, kick: false };
export const BALL_MASS = 1.2;

function disc(id: string, team: Disc["team"], x: number, y: number, radius: number, mass: number, extra: Partial<Disc> = {}): Disc {
  return { id, team, x, y, vx: 0, vy: 0, radius, mass, ...extra };
}

function createWorld(discs: Disc[], spawnPositions: Record<string, [number, number]>): GameWorld {
  const actions: Record<string, PlayerAction> = {};
  for (const body of discs) if (body.team !== "ball") actions[body.id] = { kickCooldown: 0, kickHeld: false, kickFlash: 0 };
  return { discs, scoreBlue: 0, scoreRed: 0, actions, spawnPositions, goalFlash: 0, lastGoal: null, kickoffActive: true };
}

export function createTrainingWorld(): GameWorld {
  const spawnPositions: Record<string, [number, number]> = {
    player: [250, 224], "blue-2": [250, 176], "red-1": [590, 176], "red-2": [590, 224], ball: [420, 200],
  };
  const world = createWorld([
    disc("player", "blue", 250, 224, 15, 2, { number: 1, controlled: true }),
    disc("blue-2", "blue", 250, 176, 15, 2, { number: 2 }),
    disc("red-1", "red", 590, 176, 15, 2, { number: 1 }),
    disc("red-2", "red", 590, 224, 15, 2, { number: 2 }),
    disc("ball", "ball", 420, 200, 10, BALL_MASS),
  ], spawnPositions);
  world.kickoffActive = false;
  return world;
}

export function createMatchWorld(players: MatchPlayer[]): GameWorld {
  if (players.length !== 4) throw new Error("Uma partida precisa de quatro jogadores.");
  const teamSlots: Record<Team, Array<[number, number]>> = {
    blue: [[250, 176], [250, 224]],
    red: [[590, 176], [590, 224]],
  };
  const teamCounts: Record<Team, number> = { blue: 0, red: 0 };
  const spawnPositions: Record<string, [number, number]> = { ball: [420, 200] };
  const bodies = players.map((player) => {
    const slot = teamSlots[player.team][teamCounts[player.team]++] ?? teamSlots[player.team][0];
    spawnPositions[player.id] = slot;
    return disc(player.id, player.team, slot[0], slot[1], 15, 2, { number: player.number });
  });
  bodies.push(disc("ball", "ball", 420, 200, 10, BALL_MASS));
  return createWorld(bodies, spawnPositions);
}

export function resetPositions(world: GameWorld) {
  for (const body of world.discs) {
    const position = world.spawnPositions[body.id];
    if (position) [body.x, body.y] = position;
    body.vx = 0; body.vy = 0;
  }
  for (const action of Object.values(world.actions)) {
    action.kickCooldown = 0; action.kickHeld = false; action.kickFlash = 0;
  }
  world.kickoffActive = true;
}

function length(x: number, y: number) { return Math.sqrt(x * x + y * y); }

function collide(a: Disc, b: Disc) {
  const dx = b.x - a.x; const dy = b.y - a.y; const minimum = a.radius + b.radius;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= minimum * minimum) return;
  const distance = Math.sqrt(distanceSquared) || 0.0001;
  const nx = dx / distance; const ny = dy / distance; const overlap = minimum - distance;
  const inverseA = 1 / a.mass; const inverseB = 1 / b.mass; const inverseSum = inverseA + inverseB;
  a.x -= nx * overlap * (inverseA / inverseSum); a.y -= ny * overlap * (inverseA / inverseSum);
  b.x += nx * overlap * (inverseB / inverseSum); b.y += ny * overlap * (inverseB / inverseSum);
  const closingSpeed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (closingSpeed >= 0) return;
  // Os discos padrão têm bCoef 0.5. No contato jogador-bola o coeficiente
  // combinado é 0.25; usar 0.5 aqui devolvia impulso demais ao jogador e fazia
  // a bola parecer pesada, empurrando-o para trás.
  const playerBallContact = (a.team === "ball") !== (b.team === "ball");
  const restitution = playerBallContact ? 0.25 : 0.5;
  const impulse = -(1 + restitution) * closingSpeed / inverseSum;
  a.vx -= impulse * nx * inverseA; a.vy -= impulse * ny * inverseA;
  b.vx += impulse * nx * inverseB; b.vy += impulse * ny * inverseB;
}

function collidePost(body: Disc, x: number, y: number) {
  collide(body, { id: "post", team: "ball", x, y, vx: 0, vy: 0, radius: 8, mass: 1000000 });
}

function containPlayer(body: Disc) {
  const restitution = 0.1;
  if (body.x - body.radius < PLAYER_BOUNDS.left) { body.x = PLAYER_BOUNDS.left + body.radius; body.vx = Math.abs(body.vx) * restitution; }
  else if (body.x + body.radius > PLAYER_BOUNDS.right) { body.x = PLAYER_BOUNDS.right - body.radius; body.vx = -Math.abs(body.vx) * restitution; }
  if (body.y - body.radius < PLAYER_BOUNDS.top) { body.y = PLAYER_BOUNDS.top + body.radius; body.vy = Math.abs(body.vy) * restitution; }
  else if (body.y + body.radius > PLAYER_BOUNDS.bottom) { body.y = PLAYER_BOUNDS.bottom - body.radius; body.vy = -Math.abs(body.vy) * restitution; }
}

function containBall(body: Disc) {
  const wallRestitution = 1;
  const netRestitution = 0.1;
  const inMouth = body.y > FIELD.goalTop + body.radius && body.y < FIELD.goalBottom - body.radius;
  if (body.y - body.radius < FIELD.top) { body.y = FIELD.top + body.radius; body.vy = Math.abs(body.vy) * wallRestitution; }
  else if (body.y + body.radius > FIELD.bottom) { body.y = FIELD.bottom - body.radius; body.vy = -Math.abs(body.vy) * wallRestitution; }

  if (!inMouth) {
    if (body.x - body.radius < FIELD.left) { body.x = FIELD.left + body.radius; body.vx = Math.abs(body.vx) * wallRestitution; }
    else if (body.x + body.radius > FIELD.right) { body.x = FIELD.right - body.radius; body.vx = -Math.abs(body.vx) * wallRestitution; }
  } else if (body.x < FIELD.left) {
    if (body.x - body.radius < FIELD.left - FIELD.goalDepth) { body.x = FIELD.left - FIELD.goalDepth + body.radius; body.vx = Math.abs(body.vx) * netRestitution; }
    if (body.y - body.radius < FIELD.goalTop) { body.y = FIELD.goalTop + body.radius; body.vy = Math.abs(body.vy) * netRestitution; }
    else if (body.y + body.radius > FIELD.goalBottom) { body.y = FIELD.goalBottom - body.radius; body.vy = -Math.abs(body.vy) * netRestitution; }
  } else if (body.x > FIELD.right) {
    if (body.x + body.radius > FIELD.right + FIELD.goalDepth) { body.x = FIELD.right + FIELD.goalDepth - body.radius; body.vx = -Math.abs(body.vx) * netRestitution; }
    if (body.y - body.radius < FIELD.goalTop) { body.y = FIELD.goalTop + body.radius; body.vy = Math.abs(body.vy) * netRestitution; }
    else if (body.y + body.radius > FIELD.goalBottom) { body.y = FIELD.goalBottom - body.radius; body.vy = -Math.abs(body.vy) * netRestitution; }
  }
}

function containBody(body: Disc) {
  if (body.team === "ball") containBall(body);
  else containPlayer(body);
  collidePost(body, FIELD.left, FIELD.goalTop); collidePost(body, FIELD.left, FIELD.goalBottom);
  collidePost(body, FIELD.right, FIELD.goalTop); collidePost(body, FIELD.right, FIELD.goalBottom);
}

export function applyPlayerInput(player: Disc, input: InputState, settings: PhysicsSettings, dt: number) {
  let inputX = Number(input.right) - Number(input.left); let inputY = Number(input.down) - Number(input.up);
  const magnitude = length(inputX, inputY);
  if (magnitude > 0) {
    inputX /= magnitude; inputY /= magnitude;
    const acceleration = settings.acceleration * (input.kick ? 0.7 : 1);
    player.vx += inputX * acceleration * dt; player.vy += inputY * acceleration * dt;
  }
  const drag = Math.exp(-settings.playerGrip * dt);
  player.vx *= drag; player.vy *= drag;
  const speed = length(player.vx, player.vy);
  if (speed > settings.maxSpeed) { player.vx = player.vx / speed * settings.maxSpeed; player.vy = player.vy / speed * settings.maxSpeed; }
}

function attemptKick(world: GameWorld, player: Disc, settings: PhysicsSettings) {
  const ball = world.discs.find((body) => body.team === "ball");
  const action = world.actions[player.id];
  if (!ball || !action || action.kickCooldown > 0) return;
  const dx = ball.x - player.x; const dy = ball.y - player.y; const distance = length(dx, dy);
  if (distance > player.radius + ball.radius + 0.5 || distance === 0) return;
  const nx = dx / distance; const ny = dy / distance;
  ball.vx += nx * settings.kickForce; ball.vy += ny * settings.kickForce;
  world.kickoffActive = false;
  action.kickCooldown = 0.1; action.kickFlash = 0.1;
}

export function stepMultiplayerWorld(world: GameWorld, inputs: Record<string, InputState>, settings: PhysicsSettings, dt: number, settingsByPlayer: Record<string, PhysicsSettings> = {}) {
  world.goalFlash = Math.max(0, world.goalFlash - dt);
  for (const player of world.discs) {
    if (player.team === "ball") continue;
    const input = inputs[player.id] ?? IDLE_INPUT;
    const action = world.actions[player.id] ?? (world.actions[player.id] = { kickCooldown: 0, kickHeld: false, kickFlash: 0 });
    const playerSettings = settingsByPlayer[player.id] ?? settings;
    applyPlayerInput(player, input, playerSettings, dt);
    action.kickCooldown = Math.max(0, action.kickCooldown - dt);
    action.kickFlash = Math.max(0, action.kickFlash - dt);
    // Segurar o chute prepara o contato, como no HaxBall: a tentativa se repete
    // quando o cooldown termina e a bola entra no alcance real do disco.
    if (input.kick) attemptKick(world, player, playerSettings);
    action.kickHeld = input.kick;
  }

  for (const body of world.discs) {
    if (body.team === "ball") { const drag = Math.exp(-(-Math.log(0.99) * 60) * dt); body.vx *= drag; body.vy *= drag; }
    body.x += body.vx * dt; body.y += body.vy * dt; containBody(body);
    if (world.kickoffActive && body.team === "blue" && body.x + body.radius > WORLD_WIDTH / 2) { body.x = WORLD_WIDTH / 2 - body.radius; body.vx = Math.min(0, body.vx) * 0.5; }
    if (world.kickoffActive && body.team === "red" && body.x - body.radius < WORLD_WIDTH / 2) { body.x = WORLD_WIDTH / 2 + body.radius; body.vx = Math.max(0, body.vx) * 0.5; }
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < world.discs.length; index += 1) {
      for (let other = index + 1; other < world.discs.length; other += 1) collide(world.discs[index], world.discs[other]);
    }
  }

  const ball = world.discs.find((body) => body.team === "ball");
  if (!ball) return;
  if (world.kickoffActive && (Math.abs(ball.x - WORLD_WIDTH / 2) > 0.15 || Math.abs(ball.y - WORLD_HEIGHT / 2) > 0.15 || length(ball.vx, ball.vy) > 0.5)) world.kickoffActive = false;
  if (ball.x < FIELD.left - ball.radius && ball.y > FIELD.goalTop && ball.y < FIELD.goalBottom) {
    world.scoreRed += 1; world.lastGoal = "red"; world.goalFlash = 1.1; resetPositions(world);
  } else if (ball.x > FIELD.right + ball.radius && ball.y > FIELD.goalTop && ball.y < FIELD.goalBottom) {
    world.scoreBlue += 1; world.lastGoal = "blue"; world.goalFlash = 1.1; resetPositions(world);
  }
}

export function stepWorld(world: GameWorld, input: InputState, settings: PhysicsSettings, dt: number) {
  const controlled = world.discs.find((body) => body.controlled);
  stepMultiplayerWorld(world, controlled ? { [controlled.id]: input } : {}, settings, dt);
}
