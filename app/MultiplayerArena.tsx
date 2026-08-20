"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { DEFAULT_PHYSICS, Disc, GameWorld, IDLE_INPUT, InputState, PhysicsSettings, PlayerAction, stepMultiplayerWorld, Team, WORLD_HEIGHT, WORLD_WIDTH } from "../game/physics";
import { drawArena } from "./treino/TrainingArena";
import { playGoal, playKick } from "./gameAudio";
import { SoundToggle } from "./SoundToggle";

export type MatchSnapshot = {
  matchId: string;
  tick: number;
  scoreBlue: number;
  scoreRed: number;
  goalFlash: number;
  lastGoal: Team | null;
  bodies: Disc[];
  actions: Record<string, PlayerAction>;
  period: "firstHalf" | "secondHalf";
  timeRemainingMs: number;
  periodStartsInMs: number;
  bonusTeamId: string | null;
  kickoffActive: boolean;
  processedInputs: Record<string, number>;
  serverTime: number;
  physicsHz: number;
};
export type ChatMessage = { id: string; playerId: string; nickname: string; text: string; team: Team | "spectator"; sentAt: number };

type Player = { id: string; nickname: string; online: boolean; isHost: boolean };
type MatchInfo = { matchId: string; round: number; blueTeamId: string; redTeamId: string; blueIds: string[]; redIds: string[] };
type BufferedSnapshot = MatchSnapshot & { receivedAt: number };
type PredictionState = { world: GameWorld; accumulator: number; updatedAt: number; matchId: string };
type PendingInput = { sequence: number; sentAt: number };
const BOOSTED_PHYSICS = { ...DEFAULT_PHYSICS, acceleration: DEFAULT_PHYSICS.acceleration * 1.12, maxSpeed: DEFAULT_PHYSICS.maxSpeed * 1.08, kickForce: DEFAULT_PHYSICS.kickForce * 1.15 };
const PREDICTION_STEP = 1 / 60;

function worldFromSnapshot(snapshot: MatchSnapshot): GameWorld {
  return {
    discs: snapshot.bodies.map((body) => ({ ...body })),
    scoreBlue: snapshot.scoreBlue,
    scoreRed: snapshot.scoreRed,
    actions: Object.fromEntries(Object.entries(snapshot.actions).map(([id, action]) => [id, { ...action }])),
    spawnPositions: {},
    goalFlash: snapshot.goalFlash,
    lastGoal: snapshot.lastGoal,
    kickoffActive: snapshot.kickoffActive,
  };
}

function advancePrediction(state: PredictionState, playerId: string, input: InputState, settingsByPlayer: Record<string, PhysicsSettings>, seconds: number) {
  state.accumulator += Math.min(.06, Math.max(0, seconds));
  while (state.accumulator >= PREDICTION_STEP) {
    stepMultiplayerWorld(state.world, { [playerId]: input }, DEFAULT_PHYSICS, PREDICTION_STEP, settingsByPlayer);
    state.accumulator -= PREDICTION_STEP;
  }
}

function predictedRenderWorld(state: PredictionState, playerId: string): GameWorld {
  return {
    ...state.world,
    discs: state.world.discs.map((body) => ({
      ...body,
      controlled: body.id === playerId,
    })),
  };
}

function interpolateWorld(snapshots: BufferedSnapshot[], targetTick: number): GameWorld | null {
  if (snapshots.length === 0) return null;
  const latest = snapshots[snapshots.length - 1];
  let before = snapshots[0];
  let after = latest;
  for (let index = 0; index < snapshots.length - 1; index += 1) {
    if (snapshots[index].tick <= targetTick && snapshots[index + 1].tick >= targetTick) {
      before = snapshots[index]; after = snapshots[index + 1]; break;
    }
  }
  if (targetTick <= snapshots[0].tick) before = after = snapshots[0];
  if (targetTick >= latest.tick) before = after = latest;
  const span = Math.max(1, after.tick - before.tick);
  const alpha = Math.max(0, Math.min(1, (targetTick - before.tick) / span));
  const discs = after.bodies.map((body) => {
    const previous = before.bodies.find((item) => item.id === body.id) ?? body;
    return {
      ...body,
      x: previous.x + (body.x - previous.x) * alpha,
      y: previous.y + (body.y - previous.y) * alpha,
      vx: previous.vx + (body.vx - previous.vx) * alpha,
      vy: previous.vy + (body.vy - previous.vy) * alpha,
      controlled: false,
    };
  });
  return {
    discs,
    scoreBlue: after.scoreBlue,
    scoreRed: after.scoreRed,
    actions: after.actions,
    spawnPositions: {},
    goalFlash: after.goalFlash,
    lastGoal: after.lastGoal,
    kickoffActive: after.kickoffActive,
  };
}

export function MultiplayerArena({
  subscribeSnapshots,
  playerId,
  players,
  match,
  connected,
  latencyMs,
  onInput,
  chatMessages,
  onChat,
  isHost,
  onDebugFinish,
  onDebugGolden,
}: {
  subscribeSnapshots: (listener: (snapshot: MatchSnapshot) => void) => () => void;
  playerId: string;
  players: Player[];
  match: MatchInfo;
  connected: boolean;
  latencyMs: number | null;
  onInput: (input: InputState, sequence: number) => void;
  chatMessages: ChatMessage[];
  onChat: (text: string) => void;
  isHost: boolean;
  onDebugFinish: (team: Team) => void;
  onDebugGolden: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const snapshotsRef = useRef<BufferedSnapshot[]>([]);
  const inputRef = useRef<InputState>({ ...IDLE_INPUT });
  const predictionRef = useRef<PredictionState | null>(null);
  const inputSequence = useRef(0);
  const pendingInputsRef = useRef<PendingInput[]>([]);
  const sendInputRef = useRef(onInput);
  const latencyRef = useRef(latencyMs);
  const connectedRef = useRef(connected);
  const playEnabledRef = useRef(true);
  const predictionSettingsRef = useRef<Record<string, PhysicsSettings>>({});
  const playerLabelsRef = useRef<Record<string, string>>(Object.fromEntries(players.filter((player) => !player.isHost).map((player) => [player.id, player.nickname])));
  const soundSnapshotRef = useRef<{ matchId: string; score: number; kickFlash: Record<string, number> } | null>(null);
  const hudUpdatedAtRef = useRef(0);
  const [hudSnapshot, setHudSnapshot] = useState<MatchSnapshot | null>(null);
  const [chatText, setChatText] = useState("");
  const isActive = match.blueIds.includes(playerId) || match.redIds.includes(playerId);
  const ownTeam = match.blueIds.includes(playerId) ? "blue" : match.redIds.includes(playerId) ? "red" : null;

  useEffect(() => { sendInputRef.current = onInput; }, [onInput]);
  useEffect(() => { latencyRef.current = latencyMs; }, [latencyMs]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => {
    playerLabelsRef.current = Object.fromEntries(players.filter((player) => !player.isHost).map((player) => [player.id, player.nickname]));
  }, [players]);
  useEffect(() => subscribeSnapshots((snapshot) => {
    const soundState = soundSnapshotRef.current;
    if (soundState?.matchId === snapshot.matchId) {
      if (snapshot.scoreBlue + snapshot.scoreRed > soundState.score) playGoal();
      const kicked = Object.entries(snapshot.actions).some(([id, action]) => action.kickFlash > .08 && (soundState.kickFlash[id] ?? 0) <= .08);
      if (kicked) playKick();
    }
    soundSnapshotRef.current = { matchId: snapshot.matchId, score: snapshot.scoreBlue + snapshot.scoreRed, kickFlash: Object.fromEntries(Object.entries(snapshot.actions).map(([id, action]) => [id, action.kickFlash])) };
    const buffered = { ...snapshot, receivedAt: performance.now() };
    const previousSnapshot = snapshotsRef.current.at(-1);
    const discontinuity = Boolean(previousSnapshot && (
      previousSnapshot.matchId !== snapshot.matchId ||
      previousSnapshot.period !== snapshot.period ||
      previousSnapshot.scoreBlue !== snapshot.scoreBlue ||
      previousSnapshot.scoreRed !== snapshot.scoreRed
    ));
    snapshotsRef.current = discontinuity ? [buffered] : [...snapshotsRef.current.slice(-12), buffered];
    if (!isActive) return;
    const acknowledgedSequence = snapshot.processedInputs[playerId] ?? 0;
    inputSequence.current = Math.max(inputSequence.current, acknowledgedSequence);
    pendingInputsRef.current = pendingInputsRef.current.filter((item) => item.sequence > acknowledgedSequence);
    playEnabledRef.current = snapshot.periodStartsInMs <= 0;
    const bonusIds = snapshot.period === "secondHalf" && snapshot.bonusTeamId
      ? snapshot.bonusTeamId === match.blueTeamId ? match.blueIds : snapshot.bonusTeamId === match.redTeamId ? match.redIds : []
      : [];
    predictionSettingsRef.current = Object.fromEntries(bonusIds.map((id) => [id, BOOSTED_PHYSICS]));
    const now = performance.now();
    const nextPrediction: PredictionState = { world: worldFromSnapshot(snapshot), accumulator: 0, updatedAt: now, matchId: snapshot.matchId };
    // O mundo do servidor é indivisível: jogador e bola nunca têm autoridades
    // diferentes. A previsão apenas avança o pequeno tempo de viagem pela rede
    // usando a mesma função e o mesmo passo fixo de 60 Hz do servidor.
    const oneWaySeconds = Math.min(.025, Math.max(.002, (latencyRef.current ?? 4) / 2000));
    const oldestPending = pendingInputsRef.current[0];
    const pendingSeconds = oldestPending ? Math.min(.04, Math.max(0, (now - oldestPending.sentAt) / 1000)) : 0;
    if (playEnabledRef.current) advancePrediction(nextPrediction, playerId, inputRef.current, predictionSettingsRef.current, Math.max(oneWaySeconds, pendingSeconds));
    predictionRef.current = nextPrediction;
    const previousHud = soundSnapshotRef.current;
    if (now - hudUpdatedAtRef.current >= 100 || !previousHud || previousHud.matchId !== snapshot.matchId) {
      hudUpdatedAtRef.current = now;
      setHudSnapshot(snapshot);
    }
  }), [subscribeSnapshots, isActive, match.blueIds, match.blueTeamId, match.redIds, match.redTeamId, ownTeam, playerId]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: "nearest" }); }, [chatMessages]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WORLD_WIDTH * pixelRatio;
    canvas.height = WORLD_HEIGHT * pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const sendCurrent = () => {
      if (!isActive || !connectedRef.current) return;
      inputSequence.current += 1;
      const sequence = inputSequence.current;
      pendingInputsRef.current.push({ sequence, sentAt: performance.now() });
      pendingInputsRef.current = pendingInputsRef.current.slice(-32);
      sendInputRef.current({ ...inputRef.current }, sequence);
    };
    const updateKey = (code: string, pressed: boolean) => {
      if (!isActive) return false;
      const previous = JSON.stringify(inputRef.current);
      if (code === "ArrowUp" || code === "KeyW") inputRef.current.up = pressed;
      if (code === "ArrowDown" || code === "KeyS") inputRef.current.down = pressed;
      if (code === "ArrowLeft" || code === "KeyA") inputRef.current.left = pressed;
      if (code === "ArrowRight" || code === "KeyD") inputRef.current.right = pressed;
      if (["Space", "KeyX", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Numpad0"].includes(code)) inputRef.current.kick = pressed;
      if (previous !== JSON.stringify(inputRef.current)) sendCurrent();
      return previous !== JSON.stringify(inputRef.current);
    };
    const gameKeys = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyX", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Numpad0"]);
    const isTyping = (event: KeyboardEvent) => event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    const keyDown = (event: KeyboardEvent) => { if (isTyping(event)) return; if (isActive && gameKeys.has(event.code)) event.preventDefault(); updateKey(event.code, true); };
    const keyUp = (event: KeyboardEvent) => { if (isTyping(event)) return; if (isActive && gameKeys.has(event.code)) event.preventDefault(); updateKey(event.code, false); };
    const releaseKeys = () => { inputRef.current = { ...IDLE_INPUT }; sendCurrent(); };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", releaseKeys);
    // O estado de uma tecla segurada persiste no servidor. O heartbeat é apenas
    // uma garantia contra reconexões, então 10 Hz basta e reduz bastante tráfego.
    const heartbeat = window.setInterval(sendCurrent, 100);

    let animationFrame = 0;
    const render = (now: number) => {
      let world: GameWorld | null = null;
      if (isActive && predictionRef.current) {
        const predicted = predictionRef.current;
        const predictionElapsed = Math.min(.05, Math.max(0, (now - predicted.updatedAt) / 1000));
        predicted.updatedAt = now;
        if (playEnabledRef.current) advancePrediction(predicted, playerId, inputRef.current, predictionSettingsRef.current, predictionElapsed);
        world = predictedRenderWorld(predicted, playerId);
      } else {
        const snapshots = snapshotsRef.current;
        const latest = snapshots.at(-1);
        if (latest) {
          const interpolationDelay = Math.max(34, Math.min(70, 34 + (latencyRef.current ?? 8) * .25));
          const elapsedSinceLatest = Math.max(0, now - latest.receivedAt);
          const ticksPerMillisecond = (latest.physicsHz || 60) / 1000;
          const targetTick = Math.min(latest.tick, latest.tick - interpolationDelay * ticksPerMillisecond + elapsedSinceLatest * ticksPerMillisecond);
          world = interpolateWorld(snapshots, targetTick);
        }
      }
      if (world) drawArena(context, world, playerLabelsRef.current);
      else {
        context.fillStyle = "#07111b"; context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
        context.fillStyle = "#8da3b7"; context.font = "700 16px Segoe UI, Arial"; context.textAlign = "center";
        context.fillText("Recebendo estado da partida...", WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
      }
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(animationFrame);
      clearInterval(heartbeat);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", releaseKeys);
      inputRef.current = { ...IDLE_INPUT };
      sendCurrent();
    };
  }, [isActive, ownTeam, playerId]);

  const spectators = Math.max(0, players.length - 4);
  const secondHalfCountdown = hudSnapshot?.period === "secondHalf" ? Math.ceil((hudSnapshot.periodStartsInMs ?? 0) / 1000) : 0;
  const finalCountdown = hudSnapshot?.period === "secondHalf" && secondHalfCountdown === 0 && (hudSnapshot.timeRemainingMs ?? 0) > 0 && (hudSnapshot.timeRemainingMs ?? 0) <= 5000
    ? Math.ceil((hudSnapshot.timeRemainingMs ?? 0) / 1000)
    : 0;
  const clockAlert = secondHalfCountdown === 0 && (hudSnapshot?.timeRemainingMs ?? Infinity) <= 15000;
  const stopMovementForChat = () => {
    if (!isActive) return;
    inputRef.current = { ...IDLE_INPUT };
    inputSequence.current += 1;
    const sequence = inputSequence.current;
    pendingInputsRef.current.push({ sequence, sentAt: performance.now() });
    sendInputRef.current({ ...inputRef.current }, sequence);
  };
  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    onChat(text);
    setChatText("");
  };

  return (
    <main className="match-page">
      <header className="match-header classic-nav">
        <div className="match-brand"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai <small>JOGO EDUCACIONAL</small></span></div>
        <div className="match-server-status"><span className={`status-dot ${connected ? "connected" : ""}`} /><strong>{connected ? "PARTIDA AO VIVO" : "RECONECTANDO"}</strong><small>Física sincronizada 60 Hz · servidor autoritativo</small></div>
        <div className={`role-badge ${isActive ? ownTeam : "spectator"}`}>{isActive ? `Você joga no time ${ownTeam === "blue" ? "azul" : "vermelho"}` : "Você está assistindo"}</div>
        <div className={`match-network ${!connected ? "offline" : "good"}`}><span />{!connected ? "Reconectando" : isActive ? "0 ms controle" : latencyMs === null ? "Rede local" : `${latencyMs} ms`}</div>
        <SoundToggle />
      </header>

      <section className="match-layout">
        <div className="multiplayer-field">
          {!connected && <div className="reconnect-overlay"><span className="mini-spinner" /><strong>Reconectando ao servidor</strong><small>Os seus comandos foram pausados para evitar movimentos incorretos.</small></div>}
          {secondHalfCountdown > 0 && <div className="match-countdown-overlay"><small>SEGUNDO TEMPO</small><strong>{secondHalfCountdown}</strong><span>Prepare-se!</span></div>}
          {finalCountdown > 0 && <div className="match-countdown-overlay final"><small>FIM DA PARTIDA EM</small><strong>{finalCountdown}</strong></div>}
          <div className={`classic-score ${clockAlert ? "clock-alert" : ""}`}><span className="red-chip" /><b>{hudSnapshot?.scoreRed ?? 0}</b><i>-</i><b>{hudSnapshot?.scoreBlue ?? 0}</b><span className="blue-chip" /><strong>{String(Math.floor((hudSnapshot?.timeRemainingMs ?? 0) / 60000)).padStart(2, "0")}:{String(Math.floor(((hudSnapshot?.timeRemainingMs ?? 0) % 60000) / 1000)).padStart(2, "0")}</strong></div>
          <div className="multiplayer-field-top"><span><i />SIMULAÇÃO AUTORITATIVA</span><strong>SNAPSHOT #{hudSnapshot?.tick ?? 0}</strong></div>
          <div className="canvas-frame multiplayer"><canvas ref={canvasRef} className="game-canvas" aria-label="Partida multiplayer do FuteSenai" /></div>
          <section className="hax-chat" aria-label="Chat da partida">
            <div className="hax-chat-messages">
              <p className="system-message">Move: WASD ou setas &nbsp; Chute: X, Espaço, Ctrl, Shift ou Numpad 0</p>
              <p className="system-message">{isActive ? `${hudSnapshot?.period === "secondHalf" ? "Segundo" : "Primeiro"} tempo iniciado` : `Modo espectador · ${spectators} assistindo`}</p>
              {chatMessages.map((message) => <p key={message.id} className={`chat-line ${message.team}`}><strong>{message.nickname}:</strong> {message.text}</p>)}
              <div ref={chatEndRef} />
            </div>
            <form className="hax-chat-form" onSubmit={submitChat}><input value={chatText} onFocus={stopMovementForChat} onChange={(event) => setChatText(event.target.value)} maxLength={160} aria-label="Mensagem para a sala" placeholder="Pressione Enter para conversar" /><button type="submit">Enviar</button></form>
          </section>
          <div className="match-controls">
            <div className="match-log"><strong>{isActive ? (hudSnapshot?.period === "secondHalf" && hudSnapshot.bonusTeamId === (ownTeam === "blue" ? match.blueTeamId : match.redTeamId) ? "Bônus educacional ativo" : "Resposta local imediata") : isHost ? "Professor acompanha sem jogar" : "Aguardando sua próxima partida"}</strong></div>
            {isHost && <div className="prototype-controls"><button type="button" onClick={onDebugGolden}>Forçar empate</button><button type="button" onClick={() => onDebugFinish("blue")}>Vitória azul</button><button type="button" onClick={() => onDebugFinish("red")}>Vitória vermelha</button></div>}
          </div>
        </div>
      </section>
    </main>
  );
}
