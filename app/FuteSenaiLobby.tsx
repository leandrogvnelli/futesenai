"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InputState } from "../game/physics";
import type { Team } from "../game/physics";
import type { Tournament } from "../game/tournament";
import { ChatMessage, MatchSnapshot, MultiplayerArena } from "./MultiplayerArena";
import { TournamentPresentation } from "./TournamentPresentation";
import { PublicQuiz, QuizOverlay } from "./QuizOverlay";
import { SoundToggle } from "./SoundToggle";
import { unlockAudio } from "./gameAudio";
import { createClientId } from "../game/client-id";
import { MatchBroadcastLobby, MatchSpectatorPicker, type WatchableMatch } from "./MatchSpectatorPicker";

type Player = { id: string; nickname: string; online: boolean; isHost: boolean; isBot: boolean };
type RoomSettings = { summaryDurationMs: number; matchDurationMs: number; halftimeQuestions: number; maxPlayers: number };
type EducationResult = { playerId: string; nickname: string; answered: number; correct: number; points: number; goldenWins: number; accuracy: number };
type SessionState = {
  protocolVersion?: number;
  phase: "waiting" | "lobby" | "summary" | "draw" | "bracket" | "countdown" | "match" | "quiz" | "quizResult" | "goldenQuestion" | "goldenResult" | "champion";
  title: string;
  summary: string;
  summaryCount: number;
  questionCount: number;
  players: Player[];
  joinUrl: string;
  minimumPlayers: number;
  maximumPlayers: number;
  settings: RoomSettings | null;
  match: { matchId: string; round: number; blueTeamId: string; redTeamId: string; blueIds: string[]; redIds: string[] } | null;
  availableMatches: WatchableMatch[];
  canSelectMatch: boolean;
  viewingMatchId: string | null;
  tournament: Tournament | null;
  presentation: { id: number; kind: "summary" | "draw" | "initialBracket" | "matchResult" | "countdown" | "champion"; winnerTeamId?: string; loserTeamId?: string; autoAdvanceTeamIds?: string[] } | null;
  stageDurationMs: number;
  quiz: PublicQuiz | null;
  educationResults: EducationResult[];
};
type ServerMessage =
  | { type: "state"; state: SessionState }
  | ({ type: "snapshot" } & MatchSnapshot)
  | { type: "error"; message: string }
  | { type: "created"; hostId: string; adminToken: string }
  | { type: "joined"; playerId: string }
  | { type: "pong"; clientSentAt: number; serverAt: number }
  | { type: "role"; canCreateRoom: boolean }
  | { type: "adminResult"; message: string }
  | { type: "chat"; message: ChatMessage }
  | { type: "serverClosed"; message: string };

const EMPTY_STATE: SessionState = {
  protocolVersion: 11, phase: "waiting", title: "", summary: "", summaryCount: 0, questionCount: 0,
  players: [], joinUrl: "", minimumPlayers: 4, maximumPlayers: 32, settings: null, match: null, availableMatches: [], canSelectMatch: false, viewingMatchId: null, tournament: null, presentation: null, quiz: null, educationResults: [], stageDurationMs: 0,
};

const SAMPLE_CONTENT = {
  titulo: "Segurança no ambiente de trabalho",
  resumo: "Use os equipamentos de proteção indicados para cada atividade.\n\nComunique condições inseguras assim que forem identificadas.\n\nSiga os procedimentos antes de operar máquinas e ferramentas.",
  perguntas: [
    { id: "q1", texto: "O que fazer ao identificar uma condição insegura?", alternativas: ["Ignorar se ninguém se machucou", "Comunicar imediatamente ao responsável", "Esperar o fim do turno", "Tentar esconder o problema"], correta: 1, explicacao: "A comunicação rápida ajuda a eliminar o risco antes que ocorra um acidente." },
    { id: "q2", texto: "Quando o EPI deve ser utilizado?", alternativas: ["Somente durante inspeções", "Apenas por funcionários novos", "Sempre que a atividade exigir", "Somente depois de um acidente"], correta: 2, explicacao: "O EPI deve ser usado durante toda atividade em que estiver previsto." },
    { id: "q3", texto: "Antes de operar uma máquina, o trabalhador deve:", alternativas: ["Conhecer e seguir o procedimento", "Aumentar a velocidade da máquina", "Retirar as proteções", "Pedir ajuda a qualquer colega"], correta: 0, explicacao: "Treinamento e procedimento correto são essenciais para uma operação segura." },
    { id: "q4", texto: "Qual atitude ajuda a prevenir acidentes?", alternativas: ["Improvisar ferramentas", "Manter a área organizada", "Correr em áreas operacionais", "Desativar alertas sonoros"], correta: 1, explicacao: "Organização reduz obstáculos, quedas e outros riscos no ambiente." },
    { id: "q5", texto: "Uma proteção de máquina danificada deve ser:", alternativas: ["Retirada e esquecida", "Usada normalmente", "Comunicada e corrigida antes do uso", "Pintada para esconder o dano"], correta: 2, explicacao: "A máquina não deve ser usada sem suas proteções em boas condições." },
  ],
};
const SAMPLE_SUMMARY = SAMPLE_CONTENT.resumo;
const SAMPLE_QUESTIONS = SAMPLE_CONTENT.perguntas;

function makeClientId() {
  if (typeof window === "undefined") return "";
  const stored = window.localStorage.getItem("futesenai-client-id");
  if (stored) return stored;
  const id = createClientId(window.crypto);
  window.localStorage.setItem("futesenai-client-id", id);
  return id;
}

export function FuteSenaiLobby() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(true);
  const serverWasClosedRef = useRef(false);
  const adminTokenRef = useRef("");
  const professorKeyRef = useRef("");
  const latestSnapshotRef = useRef<MatchSnapshot | null>(null);
  const snapshotSubscribersRef = useRef(new Set<(snapshot: MatchSnapshot) => void>());
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const [nickname, setNickname] = useState("");
  const [contentTitle, setContentTitle] = useState(SAMPLE_CONTENT.titulo);
  const [summaryText, setSummaryText] = useState(SAMPLE_SUMMARY);
  const [jsonContent, setJsonContent] = useState(() => JSON.stringify(SAMPLE_QUESTIONS, null, 2));
  const [summarySeconds, setSummarySeconds] = useState(15);
  const [matchMinutes, setMatchMinutes] = useState(2);
  const [halftimeQuestions, setHalftimeQuestions] = useState(5);
  const [maximumPlayers, setMaximumPlayers] = useState(32);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clientId, setClientId] = useState("");
  const [canCreateRoom, setCanCreateRoom] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [serverClosed, setServerClosed] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminCommand, setAdminCommand] = useState("/help");
  const [adminLog, setAdminLog] = useState("Console pronto. Digite /help.");

  useEffect(() => {
    aliveRef.current = true;

    const connect = () => {
      if (!aliveRef.current) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setConnected(true);
        setError("");
        const id = makeClientId();
        setClientId(id);
        socket.send(JSON.stringify({ type: "resume", clientId: id, professorKey: professorKeyRef.current }));
        const measureLatency = () => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping", clientId: id, clientSentAt: Date.now() }));
        };
        measureLatency();
        if (pingTimer.current) clearInterval(pingTimer.current);
        pingTimer.current = setInterval(measureLatency, 2000);
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "state") {
          if (message.state.protocolVersion !== 11) {
            setError("O servidor foi atualizado. Recarregue esta página.");
            return;
          }
          setState(message.state);
          if (message.state.phase !== "match" || latestSnapshotRef.current?.matchId !== message.state.match?.matchId) latestSnapshotRef.current = null;
          const ownPlayer = message.state.players.find((player) => player.id === makeClientId());
          setHasJoined(Boolean(ownPlayer));
          setIsHost(Boolean(ownPlayer?.isHost));
        }
        if (message.type === "error") { setError(message.message); setAdminLog(`ERRO: ${message.message}`); }
        if (message.type === "created") {
          adminTokenRef.current = message.adminToken;
          window.localStorage.setItem("futesenai-admin-token", message.adminToken);
          setIsHost(true); setHasJoined(true);
          setNotice("Sala criada. Compartilhe o endereço com a turma.");
        }
        if (message.type === "joined") {
          setHasJoined(true); setNotice("Você entrou no lobby.");
        }
        if (message.type === "snapshot") {
          latestSnapshotRef.current = message;
          for (const listener of snapshotSubscribersRef.current) listener(message);
        }
        if (message.type === "chat") setChatMessages((current) => [...current.slice(-79), message.message]);
        if (message.type === "pong") setLatencyMs(Math.max(0, Date.now() - message.clientSentAt));
        if (message.type === "role") setCanCreateRoom(message.canCreateRoom);
        if (message.type === "adminResult") setAdminLog(message.message);
        if (message.type === "serverClosed") {
          serverWasClosedRef.current = true;
          aliveRef.current = false;
          setServerClosed(true);
          setAdminLog(message.message);
        }
      });
      socket.addEventListener("close", () => {
        setConnected(false);
        setLatencyMs(null);
        if (pingTimer.current) clearInterval(pingTimer.current);
        socketRef.current = null;
        if (aliveRef.current && !serverWasClosedRef.current) reconnectTimer.current = setTimeout(connect, 1500);
      });
    };

    queueMicrotask(() => {
      if (!aliveRef.current) return;
      const params = new URLSearchParams(window.location.search);
      const keyFromUrl = params.get("professor")?.trim() ?? "";
      if (keyFromUrl) window.sessionStorage.setItem("futesenai-professor-key", keyFromUrl);
      professorKeyRef.current = keyFromUrl || window.sessionStorage.getItem("futesenai-professor-key") || "";
      setClientId(makeClientId());
      adminTokenRef.current = window.localStorage.getItem("futesenai-admin-token") ?? "";
      setNickname(window.localStorage.getItem("futesenai-nickname") ?? "");
      connect();
    });
    return () => {
      aliveRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      socketRef.current?.close();
    };
  }, []);

  const subscribeSnapshots = useCallback((listener: (snapshot: MatchSnapshot) => void) => {
    snapshotSubscribersRef.current.add(listener);
    const latest = latestSnapshotRef.current;
    if (latest) queueMicrotask(() => listener(latest));
    return () => { snapshotSubscribersRef.current.delete(listener); };
  }, []);

  useEffect(() => {
    const toggleAdmin = (event: KeyboardEvent) => {
      if (isHost && event.ctrlKey && event.shiftKey && event.code === "KeyK") {
        event.preventDefault(); setAdminOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", toggleAdmin);
    return () => window.removeEventListener("keydown", toggleAdmin);
  }, [isHost]);

  useEffect(() => {
    const unlock = () => { void unlockAudio(); };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, []);

  const send = (payload: object) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError("Sem conexão com o servidor. Aguarde a reconexão."); return;
    }
    setError("");
    socketRef.current.send(JSON.stringify(payload));
  };
  const saveNickname = () => {
    const clean = nickname.trim();
    if (clean) window.localStorage.setItem("futesenai-nickname", clean);
    return clean;
  };
  const createSession = (event: FormEvent) => {
    event.preventDefault();
    const cleanNickname = saveNickname();
    if (!cleanNickname) return setError("Digite o nickname do professor.");
    let questions: unknown;
    try { questions = JSON.parse(jsonContent); }
    catch { return setError("O JSON de perguntas não é válido."); }
    if (!Array.isArray(questions)) return setError("O JSON deve ser uma lista de perguntas entre [ e ].");
    const summary = summaryText.trim();
    if (!contentTitle.trim()) return setError("Digite o título do conteúdo.");
    if (!summary) return setError("Escreva o texto do resumo.");
    send({
      type: "create", clientId, nickname: cleanNickname, professorKey: professorKeyRef.current,
      content: { titulo: contentTitle.trim(), resumo: summary, perguntas: questions },
      config: { summaryDurationMs: summarySeconds * 1000, matchDurationMs: matchMinutes * 60000, halftimeQuestions, maxPlayers: maximumPlayers },
    });
  };
  const joinSession = (event: FormEvent) => {
    event.preventDefault();
    const cleanNickname = saveNickname();
    if (!cleanNickname) return setError("Escolha um nickname para entrar.");
    send({ type: "join", clientId, nickname: cleanNickname });
  };

  const hostPlayer = state.players.find((player) => player.isHost) ?? null;
  const studentPlayers = state.players.filter((player) => !player.isHost);
  const activePlayers = studentPlayers.filter((player) => player.online).length;
  const canStart = activePlayers >= state.minimumPlayers && state.phase === "lobby";
  const slots = useMemo(() => Array.from({ length: state.maximumPlayers }, (_, index) => studentPlayers[index] ?? null), [state.maximumPlayers, studentPlayers]);
  const startTournament = () => send({ type: "start", clientId, adminToken: adminTokenRef.current });
  const removePlayer = (playerId: string) => send({ type: "removePlayer", clientId, playerId, adminToken: adminTokenRef.current });
  const copyJoinUrl = async () => {
    await navigator.clipboard.writeText(state.joinUrl);
    setNotice("Endereço copiado.");
  };
  const runAdminCommand = (event: FormEvent) => {
    event.preventDefault();
    if (!adminCommand.trim()) return;
    setAdminLog(`> ${adminCommand}`);
    send({ type: "adminCommand", clientId, adminToken: adminTokenRef.current, command: adminCommand.trim() });
  };
  const shutdownServer = () => {
    if (window.confirm("Encerrar a sala e desconectar toda a turma?")) send({ type: "shutdown", clientId, adminToken: adminTokenRef.current });
  };
  const selectMatch = (matchId: string) => send({ type: "watchMatch", clientId, matchId });
  const spectatorPicker = state.canSelectMatch ? <MatchSpectatorPicker matches={state.availableMatches} selectedId={state.viewingMatchId} players={state.players} onSelect={selectMatch} onLeave={() => selectMatch("")} /> : null;
  const adminOverlay = isHost && adminOpen ? (
    <div className="admin-console-backdrop">
      <button className="admin-console-close-layer" type="button" aria-label="Fechar console" onClick={() => setAdminOpen(false)} />
      <section className="admin-console" role="dialog" aria-modal="true" aria-label="Console secreto do administrador">
        <header><div><span>ACESSO RESTRITO</span><strong>Console do administrador</strong></div><button type="button" onClick={() => setAdminOpen(false)}>×</button></header>
        <p>{adminLog}</p>
        <form onSubmit={runAdminCommand}><span>&gt;</span><input value={adminCommand} onChange={(event) => setAdminCommand(event.target.value)} aria-label="Comando administrativo" spellCheck={false} /><button type="submit">Executar</button></form>
        <small>Atalho secreto: Ctrl + Shift + K</small>
      </section>
    </div>
  ) : null;

  if (serverClosed) {
    return <main className="classic-page server-closed-page"><section className="classic-modal"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><h1>Servidor encerrado</h1><p>O professor fechou a sala. Todos os participantes foram desconectados com segurança.</p><small>Para criar outra sala, abra novamente o inicializador do FuteSenai.</small></section></main>;
  }

  if (hasJoined && state.canSelectMatch && ["match", "quiz", "quizResult", "goldenQuestion", "goldenResult"].includes(state.phase) && !state.match) {
    return <><MatchBroadcastLobby matches={state.availableMatches} players={state.players} onSelect={selectMatch} isHost={isHost} />{adminOverlay}</>;
  }

  if (state.phase === "match" && hasJoined && state.match) {
    return <><MultiplayerArena subscribeSnapshots={subscribeSnapshots} playerId={clientId} players={state.players} match={state.match} connected={connected} latencyMs={latencyMs} onInput={(input: InputState, sequence: number) => send({ type: "input", clientId, sequence, input })} chatMessages={chatMessages} onChat={(text) => send({ type: "chat", clientId, text })} isHost={isHost} onDebugFinish={(team: Team) => send({ type: "debugFinish", clientId, adminToken: adminTokenRef.current, team })} onDebugGolden={() => send({ type: "debugGolden", clientId, adminToken: adminTokenRef.current })} />{spectatorPicker}{adminOverlay}</>;
  }

  if (hasJoined && ["quiz", "quizResult", "goldenQuestion", "goldenResult"].includes(state.phase)) {
    return <><QuizOverlay phase={state.phase as "quiz" | "quizResult" | "goldenQuestion" | "goldenResult"} quiz={state.quiz} playerId={clientId} players={state.players} onAnswer={(choice) => send({ type: "answer", clientId, choice })} />{spectatorPicker}{adminOverlay}</>;
  }

  if (hasJoined && state.tournament && state.presentation && ["summary", "draw", "bracket", "countdown", "champion"].includes(state.phase)) {
    return <><TournamentPresentation phase={state.phase as "summary" | "draw" | "bracket" | "countdown" | "champion"} title={state.title} summary={state.summary} players={state.players} tournament={state.tournament} match={state.match} presentation={state.presentation} stageDurationMs={state.stageDurationMs} educationResults={state.educationResults} settings={state.settings} isHost={isHost} onRestart={() => send({ type: "restartTournament", clientId, adminToken: adminTokenRef.current })} />{adminOverlay}</>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority className="senai-logo" />
          <div className="brand-divider" />
          <div><strong className="game-name">FuteSenai</strong><span className="game-tagline">Jogo educacional SENAI</span></div>
        </div>
        <div className={`connection-pill ${connected ? "online" : "offline"}`}><span className="status-dot" />{connected ? `Servidor conectado${latencyMs !== null ? ` · ${latencyMs} ms` : ""}` : "Reconectando..."}</div>
        <SoundToggle />
      </header>

      {error && <div className="toast error-toast">{error}</div>}
      {notice && <div className="toast notice-toast">{notice}</div>}

      {state.phase === "waiting" && canCreateRoom ? (
        <section className="setup-layout">
          <div className="setup-intro">
            <Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority className="hero-senai-logo" />
            <span className="eyebrow">PROTÓTIPO EDUCACIONAL MULTIPLAYER</span>
            <h1>Monte a sala.<br />Chame a turma.<br /><span>Comece o jogo.</span></h1>
            <p>Crie um campeonato local para até 32 alunos. O conteúdo inserido aqui será usado nas disputas de conhecimento.</p>
            <div className="feature-row"><span>2 × 2</span><span>Até 32 jogadores</span><span>Rede local</span></div>
            <Link className="training-link" href="/treino">Testar movimentação <span>→</span></Link>
          </div>
          <form className="setup-panel" onSubmit={createSession}>
            <div className="panel-title-row"><div><span className="panel-kicker">PAINEL DO PROFESSOR</span><h2>Criar servidor</h2></div><span className="step-badge">01</span></div>
            <label className="field-label" htmlFor="host-nickname">Seu nickname</label>
            <input id="host-nickname" className="text-input" maxLength={18} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Ex.: Prof. Marcos" autoComplete="nickname" />
            <label className="field-label" htmlFor="content-title">Título do conteúdo</label>
            <input id="content-title" className="text-input" maxLength={80} value={contentTitle} onChange={(event) => setContentTitle(event.target.value)} placeholder="Ex.: Segurança no trabalho" />
            <label className="field-label" htmlFor="content-summary">Resumo para leitura</label>
            <textarea id="content-summary" className="summary-input" value={summaryText} onChange={(event) => setSummaryText(event.target.value)} placeholder="Cole ou escreva o texto já formatado. As quebras de linha serão preservadas." />
            <div className="room-config-grid">
              <label>Leitura do resumo<input type="number" min="5" max="300" value={summarySeconds} onChange={(event) => setSummarySeconds(Number(event.target.value))} /><span>segundos</span></label>
              <label>Partida completa<input type="number" min="0.5" max="20" step="0.5" value={matchMinutes} onChange={(event) => setMatchMinutes(Number(event.target.value))} /><span>minutos</span></label>
              <label>Perguntas no intervalo<input type="number" min="1" max="20" value={halftimeQuestions} onChange={(event) => setHalftimeQuestions(Number(event.target.value))} /><span>perguntas</span></label>
              <label>Máximo de alunos<input type="number" min="4" max="32" value={maximumPlayers} onChange={(event) => setMaximumPlayers(Number(event.target.value))} /><span>alunos</span></label>
            </div>
            <div className="json-label-row"><label className="field-label" htmlFor="questions-json">JSON de perguntas e respostas</label><button type="button" className="text-button" onClick={() => setJsonContent(JSON.stringify(SAMPLE_QUESTIONS, null, 2))}>Usar exemplo</button></div>
            <textarea id="questions-json" className="json-input" value={jsonContent} onChange={(event) => setJsonContent(event.target.value)} spellCheck={false} />
            <p className="field-help">O JSON contém somente uma lista de perguntas. Cada uma precisa de 4 alternativas, índice da correta e explicação.</p>
            <button className="primary-button" type="submit" disabled={!connected}><span>Criar servidor</span><span aria-hidden="true">→</span></button>
          </form>
        </section>
      ) : state.phase === "waiting" ? (
        <section className="join-stage">
          <div className="ball-mark" aria-hidden="true"><span /></div><span className="eyebrow">FUTESENAI</span><h1>Aguardando o professor</h1>
          <p>O servidor ainda não criou o campeonato. Esta tela será atualizada automaticamente.</p><div className="waiting-bar"><span /></div>
        </section>
      ) : !hasJoined ? (
        <section className="join-stage">
          <Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority className="hero-senai-logo" />
          <div className="ball-mark" aria-hidden="true"><span /></div><span className="eyebrow">SALA ABERTA</span><h1>{state.title}</h1><p>Escolha como seu nome aparecerá para a turma.</p>
          <form className="join-form" onSubmit={joinSession}><input className="text-input join-input" maxLength={18} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Seu nickname" autoComplete="nickname" /><button className="primary-button compact" type="submit">Entrar no lobby</button></form>
          <span className="capacity-label">{activePlayers}/{state.maximumPlayers} alunos conectados</span>
        </section>
      ) : (
        <section className="lobby-wrap">
          <div className="room-heading">
            <div><span className="eyebrow">SALA DE CAMPEONATO</span><h1>{state.title}</h1></div>
            <div className="room-code"><span>ENDEREÇO PARA ENTRAR</span><strong>{state.joinUrl || "Descobrindo endereço..."}</strong>{isHost && <button type="button" onClick={copyJoinUrl}>Copiar</button>}</div>
          </div>
          <div className="lobby-grid">
            <section className="players-panel">
              <div className="players-header"><div><span className="live-dot" />ROOM LIST · ALUNOS NA SALA</div><strong>{activePlayers}<small>/{state.maximumPlayers}</small></strong></div>
              {hostPlayer && <div className="host-spectator-row"><span className="player-avatar color-0">{hostPlayer.nickname.slice(0, 1).toUpperCase()}</span><span><strong>{hostPlayer.nickname}</strong><small>PROFESSOR · HOST · ESPECTADOR FIXO</small></span>{!hostPlayer.online && <span className="offline-tag">OFFLINE</span>}</div>}
              <div className="player-slots">
                {slots.map((player, index) => (
                  <div className={`player-slot ${player ? "filled" : ""}`} key={player?.id ?? `slot-${index}`}>
                    <span className="slot-number">{String(index + 1).padStart(2, "0")}</span>
                    {player ? <><span className={`player-avatar color-${index % 4}`}>{player.nickname.slice(0, 1).toUpperCase()}</span><span className="player-name">{player.nickname}</span>{player.isBot && <span className="bot-tag">BOT</span>}{!player.online && <span className="offline-tag">OFFLINE</span>}{isHost && <button className="remove-player" type="button" onClick={() => removePlayer(player.id)} aria-label={`Remover ${player.nickname}`}>×</button>}</> : <span className="empty-slot">Aguardando aluno...</span>}
                  </div>
                ))}
              </div>
            </section>
            <aside className="room-sidebar">
              <div className="sidebar-card"><span className="sidebar-label">FORMATO</span><div className="format-score"><strong>2</strong><span>×</span><strong>2</strong></div><p>Duplas sorteadas no início do campeonato.</p></div>
              <div className="sidebar-card info-card"><span className="sidebar-label">CONTEÚDO CARREGADO</span><strong>{state.questionCount} perguntas</strong><p>Resumo pronto para apresentação.</p></div>
              <div className="sidebar-card info-card"><span className="sidebar-label">CONFIGURAÇÃO</span><strong>{Math.round((state.settings?.matchDurationMs ?? 120000) / 60000 * 10) / 10} min</strong><p>{state.settings?.halftimeQuestions ?? 5} perguntas no intervalo.</p></div>
              <div className="sidebar-card rules-card"><span className="sidebar-label">PARA COMEÇAR</span><div className={`requirement ${activePlayers >= 4 ? "complete" : ""}`}><span>{activePlayers >= 4 ? "✓" : activePlayers}</span><p><strong>Mínimo de 4 alunos</strong>{activePlayers >= 4 ? "Tudo pronto para iniciar." : `Faltam ${4 - activePlayers} alunos.`}</p></div></div>
              {isHost ? <><button className="start-button" type="button" disabled={!canStart} onClick={startTournament}>Iniciar campeonato<span>→</span></button><button className="shutdown-button" type="button" onClick={shutdownServer}>Encerrar sala</button></> : <div className="waiting-host"><span className="mini-spinner" />Aguardando o professor iniciar</div>}
            </aside>
          </div>
        </section>
      )}
      <footer className="footer-bar"><span>FuteSenai · Protótipo online</span><span>{state.phase === "lobby" ? "Lobby aberto" : "Aguardando sala"}</span></footer>
      {adminOverlay}
    </main>
  );
}
