"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createTrainingWorld,
  DEFAULT_PHYSICS,
  FIELD,
  GameWorld,
  InputState,
  PhysicsSettings,
  stepWorld,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../../game/physics";

const EMPTY_INPUT: InputState = { up: false, down: false, left: false, right: false, kick: false };

function drawGoal(ctx: CanvasRenderingContext2D, side: "left" | "right") {
  const lineX = side === "left" ? FIELD.left : FIELD.right;
  const backX = side === "left" ? FIELD.left - FIELD.goalDepth : FIELD.right + FIELD.goalDepth;
  const shoulderX = side === "left" ? FIELD.left - 10 : FIELD.right + 10;
  ctx.save();
  ctx.strokeStyle = "#050505";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(lineX, FIELD.goalTop);
  ctx.lineTo(shoulderX, FIELD.goalTop);
  ctx.quadraticCurveTo(backX, FIELD.goalTop, backX, FIELD.goalTop + 20);
  ctx.lineTo(backX, FIELD.goalBottom - 20);
  ctx.quadraticCurveTo(backX, FIELD.goalBottom, shoulderX, FIELD.goalBottom);
  ctx.lineTo(lineX, FIELD.goalBottom);
  ctx.stroke();
  ctx.restore();
}

function drawDisc(ctx: CanvasRenderingContext2D, body: GameWorld["discs"][number], world: GameWorld) {
  ctx.save();
  ctx.translate(body.x, body.y);
  if (body.team === "ball") {
    ctx.beginPath(); ctx.arc(0, 0, body.radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = "#050505"; ctx.stroke();
    ctx.restore(); return;
  }

  if (body.controlled) {
    ctx.beginPath(); ctx.arc(0, 0, body.radius + 7, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232, 239, 230, .48)";
    ctx.lineWidth = 4; ctx.stroke();
  }
  if (world.actions[body.id]?.kickHeld || (world.actions[body.id]?.kickFlash ?? 0) > 0) {
    ctx.beginPath(); ctx.arc(0, 0, body.radius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, body.radius, 0, Math.PI * 2);
  ctx.fillStyle = body.team === "blue" ? "#5689e5" : "#e56e56"; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = "#050505"; ctx.stroke();
  ctx.fillStyle = "white"; ctx.font = "900 12px Segoe UI, Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(body.number ?? ""), 0, 0);
  ctx.restore();
}

export function drawArena(ctx: CanvasRenderingContext2D, world: GameWorld, playerLabels: Record<string, string> = {}) {
  ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  ctx.fillStyle = "#718c5b"; ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  drawGoal(ctx, "left"); drawGoal(ctx, "right");

  ctx.fillStyle = "#6b9a61";
  ctx.fillRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);
  ctx.save();
  ctx.beginPath(); ctx.rect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top); ctx.clip();
  ctx.translate(-90, 0); ctx.rotate(-Math.PI / 4);
  for (let x = -WORLD_HEIGHT; x < WORLD_WIDTH + WORLD_HEIGHT; x += 92) {
    ctx.fillStyle = "rgba(255,255,255,.06)"; ctx.fillRect(x, -WORLD_HEIGHT, 46, WORLD_HEIGHT * 3);
  }
  ctx.restore();
  ctx.strokeStyle = "#cbe4c4"; ctx.lineWidth = 3;
  ctx.strokeRect(FIELD.left, FIELD.top, FIELD.right - FIELD.left, FIELD.bottom - FIELD.top);
  ctx.beginPath(); ctx.moveTo(WORLD_WIDTH / 2, FIELD.top); ctx.lineTo(WORLD_WIDTH / 2, FIELD.bottom); ctx.stroke();
  ctx.beginPath(); ctx.arc(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 75, 0, Math.PI * 2); ctx.stroke();

  for (const [x, y, color] of [[FIELD.left, FIELD.goalTop, "#ffb3bc"], [FIELD.left, FIELD.goalBottom, "#ffb3bc"], [FIELD.right, FIELD.goalTop, "#b9b8ff"], [FIELD.right, FIELD.goalBottom, "#b9b8ff"]] as Array<[number, number, string]>) {
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#050505"; ctx.stroke();
  }
  for (const body of world.discs) drawDisc(ctx, body, world);
  for (const body of world.discs) {
    const nickname = body.team === "ball" ? "" : playerLabels[body.id];
    if (!nickname) continue;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 12px Arial, Helvetica, sans-serif";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0, 0, 0, .9)";
    ctx.strokeText(nickname, body.x, body.y + body.radius + 12, 110);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(nickname, body.x, body.y + body.radius + 12, 110);
    ctx.restore();
  }

  if (world.goalFlash > 0 && world.lastGoal) {
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(16,25,31,.82)"; ctx.fillRect(WORLD_WIDTH / 2 - 78, WORLD_HEIGHT / 2 - 25, 156, 50);
    ctx.fillStyle = "#fff"; ctx.font = "900 25px Arial"; ctx.fillText("GOL!", WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
  }
}

export function TrainingArena() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef(createTrainingWorld());
  const inputRef = useRef<InputState>({ ...EMPTY_INPUT });
  const settingsRef = useRef<PhysicsSettings>({ ...DEFAULT_PHYSICS });
  const pausedRef = useRef(false);
  const [settings, setSettings] = useState<PhysicsSettings>({ ...DEFAULT_PHYSICS });
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState({ playerSpeed: 0, ballSpeed: 0 });

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = WORLD_WIDTH * pixelRatio;
    canvas.height = WORLD_HEIGHT * pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const updateKey = (code: string, pressed: boolean) => {
      if (code === "ArrowUp" || code === "KeyW") inputRef.current.up = pressed;
      if (code === "ArrowDown" || code === "KeyS") inputRef.current.down = pressed;
      if (code === "ArrowLeft" || code === "KeyA") inputRef.current.left = pressed;
      if (code === "ArrowRight" || code === "KeyD") inputRef.current.right = pressed;
      if (["Space", "KeyX", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Numpad0"].includes(code)) inputRef.current.kick = pressed;
    };
    const gameKeys = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyX", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "Numpad0"]);
    const onKeyDown = (event: KeyboardEvent) => { if (gameKeys.has(event.code)) event.preventDefault(); updateKey(event.code, true); };
    const onKeyUp = (event: KeyboardEvent) => { if (gameKeys.has(event.code)) event.preventDefault(); updateKey(event.code, false); };
    const onBlur = () => { inputRef.current = { ...EMPTY_INPUT }; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const fixedStep = 1 / 120;
    let previous = performance.now();
    let accumulator = 0;
    let statsTimer = 0;
    let frameId = 0;
    const frame = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, .05);
      previous = now;
      if (!pausedRef.current) {
        accumulator += elapsed;
        while (accumulator >= fixedStep) {
          stepWorld(worldRef.current, inputRef.current, settingsRef.current, fixedStep);
          accumulator -= fixedStep;
        }
      }
      drawArena(context, worldRef.current);
      statsTimer += elapsed;
      if (statsTimer >= .2) {
        statsTimer = 0;
        const player = worldRef.current.discs.find((body) => body.controlled);
        const ball = worldRef.current.discs.find((body) => body.team === "ball");
        setStats({ playerSpeed: Math.round(Math.hypot(player?.vx ?? 0, player?.vy ?? 0)), ballSpeed: Math.round(Math.hypot(ball?.vx ?? 0, ball?.vy ?? 0)) });
      }
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const changeSetting = (key: keyof PhysicsSettings, value: number) => setSettings((current) => ({ ...current, [key]: value }));
  const resetGame = () => { worldRef.current = createTrainingWorld(); setPaused(false); pausedRef.current = false; };
  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); inputRef.current = { ...EMPTY_INPUT }; };
  const applyPreset = (preset: "balanced" | "fast" | "heavy") => {
    const next = preset === "balanced" ? DEFAULT_PHYSICS : preset === "fast"
      ? { acceleration: 540, maxSpeed: 205, kickForce: 390, playerGrip: 2.3 }
      : { acceleration: 340, maxSpeed: 150, kickForce: 380, playerGrip: 2.8 };
    setSettings({ ...next });
  };

  return (
    <main className="training-page">
      <header className="training-header">
        <Link href="/" className="training-brand"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai</span></Link>
        <div><span className="phase-chip">PARTE 2</span><strong>Laboratório de movimentação</strong></div>
        <Link href="/" className="back-button">← Voltar ao lobby</Link>
      </header>

      <section className="training-layout">
        <div className="arena-column">
          <div className="arena-toolbar">
            <div><span className="live-dot" /><strong>CAMPO DE TESTES</strong><small>Física local a 120 Hz</small></div>
            <div className="toolbar-actions"><button type="button" onClick={togglePause}>{paused ? "Continuar" : "Pausar"}</button><button type="button" onClick={resetGame}>Reiniciar</button></div>
          </div>
          <div className="canvas-frame"><canvas ref={canvasRef} className="game-canvas" aria-label="Campo de treino jogável do FuteSenai" /></div>
          <div className="controls-strip">
            <div><span className="key-group"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><p><strong>Mover</strong>Também aceita as setas</p></div>
            <div><span className="key-group"><kbd>ESPAÇO</kbd></span><p><strong>Chutar</strong>Também aceita X, Ctrl ou Shift</p></div>
            <div className="speed-readout"><span><small>JOGADOR</small>{stats.playerSpeed}</span><span><small>BOLA</small>{stats.ballSpeed}</span><em>velocidade</em></div>
          </div>
        </div>

        <aside className="tuning-panel">
          <span className="eyebrow">AJUSTE FINO</span><h1>Sensação do jogo</h1><p>Teste os valores enquanto joga. Eles serão reutilizados no servidor multiplayer.</p>
          <div className="preset-row"><button type="button" onClick={() => applyPreset("balanced")}>Balanceado</button><button type="button" onClick={() => applyPreset("fast")}>Rápido</button><button type="button" onClick={() => applyPreset("heavy")}>Pesado</button></div>
          <div className="range-control"><span><label htmlFor="acceleration">Aceleração</label><output>{settings.acceleration}</output></span><input id="acceleration" type="range" min="250" max="700" step="10" value={settings.acceleration} onChange={(event) => changeSetting("acceleration", Number(event.target.value))} /></div>
          <div className="range-control"><span><label htmlFor="max-speed">Velocidade máxima</label><output>{settings.maxSpeed}</output></span><input id="max-speed" type="range" min="120" max="240" step="2" value={settings.maxSpeed} onChange={(event) => changeSetting("maxSpeed", Number(event.target.value))} /></div>
          <div className="range-control"><span><label htmlFor="kick-force">Força do chute</label><output>{settings.kickForce}</output></span><input id="kick-force" type="range" min="250" max="480" step="5" value={settings.kickForce} onChange={(event) => changeSetting("kickForce", Number(event.target.value))} /></div>
          <div className="range-control"><span><label htmlFor="player-grip">Freio do jogador</label><output>{settings.playerGrip.toFixed(1)}</output></span><input id="player-grip" type="range" min="1.5" max="5" step="0.05" value={settings.playerGrip} onChange={(event) => changeSetting("playerGrip", Number(event.target.value))} /></div>
          <div className="physics-note"><span>i</span><p>O disco com o <strong>aro externo</strong> é controlável. Segurar o chute prepara o contato e reduz a aceleração, como no HaxBall.</p></div>
        </aside>
      </section>
    </main>
  );
}
