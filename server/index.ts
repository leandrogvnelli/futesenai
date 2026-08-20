import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createMatchWorld, DEFAULT_PHYSICS, IDLE_INPUT, resetPositions, stepMultiplayerWorld } from "../game/physics.ts";
import type { GameWorld, InputState } from "../game/physics.ts";
import { beginTournamentMatchById, completeTournamentMatchById, createTournament } from "../game/tournament.ts";
import type { BracketMatch, Tournament } from "../game/tournament.ts";
import { scoreAnswer, selectQuestions, teamQuizResult } from "../game/quiz.ts";

const PORT = Number(process.env.PORT ?? 3001);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);
const CLOUD_MODE = process.env.FUTESENAI_CLOUD === "1" || Boolean(process.env.RENDER);
const PROFESSOR_KEY = String(process.env.PROFESSOR_KEY ?? "").trim();
const PROTOCOL_VERSION = 11;
const MAX_PLAYERS = 32;
const MIN_PLAYERS = 4;
// Servidor e cliente ativo usam a mesma simulação e o mesmo passo fixo. O
// servidor é a única autoridade sobre jogadores, bola, colisões e placar.
const PHYSICS_HZ = 60;
const FAST = process.env.FAST_TRANSITIONS === "1";
const DURATION = FAST
  ? { draw: 20, bracket: 20, countdown: 20, result: 20, answer: 35, feedback: 15, quizResult: 25, goldenAnswer: 50, goldenFeedback: 20 }
  : { draw: 5000, bracket: 6500, countdown: 4000, result: 6000, answer: 8000, feedback: 2500, quizResult: 6000, goldenAnswer: 8000, goldenFeedback: 3000 };

type Phase = "lobby" | "summary" | "draw" | "bracket" | "countdown" | "match" | "quiz" | "quizResult" | "goldenQuestion" | "goldenResult" | "champion";
type Player = { id: string; nickname: string; online: boolean; isHost: boolean; isBot: boolean };
type Question = { id: string; texto: string; alternativas: string[]; correta: number; explicacao: string };
type Content = { titulo: string; resumo: string; perguntas: Question[] };
type SessionConfig = { summaryDurationMs: number; matchDurationMs: number; halftimeQuestions: number; maxPlayers: number };
type EducationStats = { answered: number; correct: number; points: number; goldenWins: number };
type MatchState = {
  world: GameWorld;
  inputs: Record<string, InputState>;
  inputSequences: Record<string, number>;
  tick: number;
  bracketMatchId: string;
  blueTeamId: string;
  redTeamId: string;
  blueIds: string[];
  redIds: string[];
  finishing: boolean;
  period: "firstHalf" | "secondHalf";
  periodStartsAt: number;
  periodEndsAt: number;
  bonusTeamId: string | null;
  goldenUsedIds: string[];
};
type QuizState = {
  mode: "halftime" | "golden";
  questions: Question[];
  index: number;
  stage: "answering" | "feedback" | "result";
  answers: Record<string, number>;
  scores: Record<string, number>;
  questionStartedAt: number;
  timeLimitMs: number;
  blueScore: number;
  redScore: number;
  winner: "blue" | "red" | null;
  attempt: number;
  winnerPlayerId: string | null;
};
type Presentation = {
  id: number;
  kind: "summary" | "draw" | "initialBracket" | "matchResult" | "countdown" | "champion";
  winnerTeamId?: string;
  loserTeamId?: string;
  autoAdvanceTeamIds?: string[];
};
type Session = {
  phase: Phase;
  hostId: string;
  adminToken: string;
  content: Content;
  config: SessionConfig;
  players: Player[];
  tournament: Tournament | null;
  matches: Record<string, MatchState>;
  presentation: Presentation | null;
  quizzes: Record<string, QuizState>;
  viewingMatchByClient: Record<string, string>;
  roundResults: Array<{ winnerId: string; loserId: string | null }>;
  educationStats: Record<string, EducationStats>;
  stageDurationMs: number;
};

let session: Session | null = null;
let presentationId = 0;
let transitionTimer: ReturnType<typeof setTimeout> | null = null;
const clients = new Map<string, WebSocket>();
let detectedPublicUrl = String(process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

function hasProfessorAccess(value: unknown) {
  if (!CLOUD_MODE) return true;
  return Boolean(PROFESSOR_KEY) && String(value ?? "") === PROFESSOR_KEY;
}

function cleanNickname(value: unknown) { return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, 18); }
function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}
function resolveConfig(value: unknown): SessionConfig {
  const config = value && typeof value === "object" ? value as Partial<Record<keyof SessionConfig, unknown>> : {};
  return {
    summaryDurationMs: Math.round(boundedNumber(config.summaryDurationMs, 15000, 5000, 300000)),
    matchDurationMs: Math.round(boundedNumber(config.matchDurationMs, 120000, 30000, 1200000)),
    halftimeQuestions: Math.round(boundedNumber(config.halftimeQuestions, 5, 1, 20)),
    maxPlayers: Math.round(boundedNumber(config.maxPlayers, MAX_PLAYERS, MIN_PLAYERS, MAX_PLAYERS)),
  };
}
function summaryDuration() { return FAST ? 20 : session?.config.summaryDurationMs ?? 15000; }
function halfDuration() { return FAST ? 5000 : Math.round((session?.config.matchDurationMs ?? 120000) / 2); }
function normalizeContent(value: unknown): Content {
  if (!value || typeof value !== "object") throw new Error("O conteúdo precisa ser um objeto JSON.");
  const raw = value as { titulo?: unknown; resumo?: unknown; perguntas?: unknown };
  const content: Content = {
    titulo: typeof raw.titulo === "string" ? raw.titulo.trim() : "",
    resumo: typeof raw.resumo === "string"
      ? raw.resumo.trim()
      : Array.isArray(raw.resumo) ? raw.resumo.map((item) => String(item).trim()).filter(Boolean).join("\n\n") : "",
    perguntas: Array.isArray(raw.perguntas) ? raw.perguntas as Question[] : [],
  };
  if (typeof content.titulo !== "string" || !content.titulo.trim()) throw new Error("Informe o campo 'titulo'.");
  if (!content.resumo) throw new Error("Escreva o texto do resumo.");
  if (!Array.isArray(content.perguntas) || content.perguntas.length < 1) throw new Error("Insira pelo menos uma pergunta.");
  const ids = new Set<string>();
  content.perguntas.forEach((question, index) => {
    if (!question || typeof question !== "object") throw new Error(`Pergunta ${index + 1} inválida.`);
    if (typeof question.id !== "string" || !question.id.trim() || ids.has(question.id)) throw new Error(`A pergunta ${index + 1} precisa de um id único.`);
    ids.add(question.id);
    if (typeof question.texto !== "string" || !question.texto.trim()) throw new Error(`A pergunta ${index + 1} não tem enunciado.`);
    if (!Array.isArray(question.alternativas) || question.alternativas.length !== 4) throw new Error(`A pergunta ${index + 1} precisa ter 4 alternativas.`);
    if (!Number.isInteger(question.correta) || question.correta < 0 || question.correta > 3) throw new Error(`A resposta correta da pergunta ${index + 1} deve ser um índice de 0 a 3.`);
    if (typeof question.explicacao !== "string" || !question.explicacao.trim()) throw new Error(`A pergunta ${index + 1} precisa de uma explicação.`);
  });
  return content;
}

function readyRoundMatches() {
  if (!session?.tournament) return [];
  const waiting = session.tournament.matches.filter((match) => match.status === "waiting" && !match.resolved);
  const round = Math.min(...waiting.map((match) => match.round));
  return Number.isFinite(round) ? waiting.filter((match) => match.round === round) : [];
}

function bracketMatchInfo(bracketMatch: BracketMatch | undefined) {
  if (!session?.tournament || !bracketMatch?.teamAId || !bracketMatch.teamBId) return null;
  if (!bracketMatch?.teamAId || !bracketMatch.teamBId) return null;
  const blue = session.tournament.teams.find((team) => team.id === bracketMatch.teamAId);
  const red = session.tournament.teams.find((team) => team.id === bracketMatch.teamBId);
  if (!blue || !red) return null;
  return {
    matchId: bracketMatch.id,
    round: bracketMatch.round,
    blueTeamId: blue.id,
    redTeamId: red.id,
    blueIds: blue.playerIds,
    redIds: red.playerIds,
  };
}

function runtimeMatchForClient(clientId: string | null) {
  if (!session) return null;
  const matches = Object.values(session.matches);
  const own = clientId ? matches.find((match) => match.blueIds.includes(clientId) || match.redIds.includes(clientId)) : null;
  if (own) return own;
  const selected = clientId ? session.viewingMatchByClient[clientId] : null;
  if (selected && session.matches[selected]) return session.matches[selected];
  const player = clientId ? session.players.find((item) => item.id === clientId) : null;
  const onlyGoldenMatchesRemain = matches.length > 0 && matches.every((match) => session!.quizzes[match.bracketMatchId]?.mode === "golden");
  return !player?.isHost && onlyGoldenMatchesRemain ? matches[0] : null;
}

function bracketMatchForClient(clientId: string | null) {
  if (!session?.tournament) return undefined;
  const runtime = runtimeMatchForClient(clientId);
  if (runtime) return session.tournament.matches.find((match) => match.id === runtime.bracketMatchId);
  const ready = readyRoundMatches();
  const own = clientId ? ready.find((match) => {
    const teams = session!.tournament!.teams.filter((team) => team.playerIds.includes(clientId));
    return teams.some((team) => team.id === match.teamAId || team.id === match.teamBId);
  }) : null;
  const selected = clientId ? session.viewingMatchByClient[clientId] : null;
  return own ?? ready.find((match) => match.id === selected) ?? ready[0];
}

function availableMatches() {
  if (!session?.tournament) return [];
  const bracketMatches = Object.keys(session.matches).length
    ? Object.keys(session.matches).map((id) => session!.tournament!.matches.find((match) => match.id === id)).filter(Boolean) as BracketMatch[]
    : readyRoundMatches();
  return bracketMatches.map((match) => ({
    ...bracketMatchInfo(match),
    stage: session!.quizzes[match.id]?.mode === "golden" ? "golden" : session!.phase === "quiz" || session!.phase === "quizResult" ? "halftime" : "playing",
  })).filter((match) => match.matchId);
}

function canSelectMatch(clientId: string | null) {
  if (!session || !clientId) return false;
  return !Object.values(session.matches).some((match) => match.blueIds.includes(clientId) || match.redIds.includes(clientId));
}

function publicState(clientId: string | null = null) {
  if (!session) return { protocolVersion: PROTOCOL_VERSION, phase: "waiting", title: "", summary: "", summaryCount: 0, questionCount: 0, players: [], joinUrl: "", minimumPlayers: MIN_PLAYERS, maximumPlayers: MAX_PLAYERS, settings: null, match: null, availableMatches: [], canSelectMatch: false, viewingMatchId: null, tournament: null, presentation: null, quiz: null, educationResults: [], stageDurationMs: 0 };
  const bracketMatch = bracketMatchForClient(clientId);
  const viewerQuiz = publicQuiz(clientId);
  const viewerPhase = session.phase === "goldenQuestion" && viewerQuiz?.winnerPlayerId ? "goldenResult" : session.phase;
  return {
    protocolVersion: PROTOCOL_VERSION,
    phase: viewerPhase,
    title: session.content.titulo,
    summary: session.content.resumo,
    summaryCount: session.content.resumo ? 1 : 0,
    questionCount: session.content.perguntas.length,
    players: session.players.map(({ id, nickname, online, isHost, isBot }) => ({ id, nickname, online, isHost, isBot })),
    joinUrl: detectedPublicUrl,
    minimumPlayers: MIN_PLAYERS,
    maximumPlayers: session.config.maxPlayers,
    settings: session.config,
    match: bracketMatchInfo(bracketMatch),
    availableMatches: availableMatches(),
    canSelectMatch: canSelectMatch(clientId),
    viewingMatchId: bracketMatch?.id ?? null,
    tournament: session.tournament,
    presentation: session.presentation,
    quiz: viewerQuiz,
    educationResults: session.players.filter((player) => !player.isHost).map((player) => {
      const stats = session!.educationStats[player.id] ?? { answered: 0, correct: 0, points: 0, goldenWins: 0 };
      return { playerId: player.id, nickname: player.nickname, ...stats, accuracy: stats.answered ? Math.round(stats.correct / stats.answered * 100) : 0 };
    }),
    stageDurationMs: session.stageDurationMs,
  };
}

function publicQuiz(clientId: string | null) {
  const match = runtimeMatchForClient(clientId);
  if (!session || !match) return null;
  const quiz = session.quizzes[match.bracketMatchId];
  if (!quiz) return null;
  const question = quiz.questions[quiz.index];
  return {
    index: quiz.index,
    total: quiz.questions.length,
    stage: quiz.stage,
    question: question ? {
      id: question.id,
      texto: question.texto,
      alternativas: question.alternativas,
      ...(quiz.stage === "feedback" ? { correta: question.correta, explicacao: question.explicacao } : {}),
    } : null,
    answeredIds: Object.keys(quiz.answers),
    scores: quiz.stage === "result" ? quiz.scores : undefined,
    blueScore: quiz.blueScore,
    redScore: quiz.redScore,
    winner: quiz.winner,
    timeLimitMs: quiz.timeLimitMs,
    questionStartedAt: quiz.questionStartedAt,
    activeIds: [...match.blueIds, ...match.redIds],
    mode: quiz.mode,
    attempt: quiz.attempt,
    winnerPlayerId: quiz.winnerPlayerId,
  };
}

function send(socket: WebSocket, message: unknown) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function broadcast(message: unknown) {
  const encoded = JSON.stringify(message);
  for (const socket of clients.values()) if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
}
function broadcastState() {
  for (const [clientId, socket] of clients) send(socket, { type: "state", state: publicState(clientId) });
}
function sendSnapshots() {
  if (!session) return;
  const encodedByMatch = new Map<string, string>();
  for (const [clientId, socket] of clients) {
    const match = runtimeMatchForClient(clientId);
    if (!match || socket.readyState !== WebSocket.OPEN) continue;
    let encoded = encodedByMatch.get(match.bracketMatchId);
    if (!encoded) {
      encoded = JSON.stringify(snapshotPayload(match));
      encodedByMatch.set(match.bracketMatchId, encoded);
    }
    socket.send(encoded);
  }
}
function fail(socket: WebSocket, message: string) { send(socket, { type: "error", message }); }
function assertHost(clientId: string, token: unknown) {
  if (!session || session.hostId !== clientId || session.adminToken !== String(token ?? "")) throw new Error("Acesso administrativo negado.");
}
function sanitizeInput(value: unknown): InputState {
  const input = value && typeof value === "object" ? value as Partial<InputState> : {};
  return { up: input.up === true, down: input.down === true, left: input.left === true, right: input.right === true, kick: input.kick === true };
}

function schedule(callback: () => void, duration: number) {
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionTimer = setTimeout(callback, duration);
}
function setPresentation(phase: Phase, duration: number, presentation: Omit<Presentation, "id">) {
  if (!session) return;
  session.phase = phase;
  session.stageDurationMs = duration;
  session.presentation = { ...presentation, id: ++presentationId };
  broadcastState();
}

function beginCountdown() {
  if (!session?.tournament || readyRoundMatches().length === 0) return;
  setPresentation("countdown", DURATION.countdown, { kind: "countdown" });
  schedule(startCurrentRound, DURATION.countdown);
}

function createRuntimeMatch(bracketMatch: BracketMatch) {
  if (!session?.tournament) return;
  beginTournamentMatchById(session.tournament, bracketMatch.id);
  const blueTeam = session.tournament.teams.find((team) => team.id === bracketMatch.teamAId);
  const redTeam = session.tournament.teams.find((team) => team.id === bracketMatch.teamBId);
  if (!blueTeam || !redTeam) throw new Error("Times do confronto não encontrados.");
  const assignments = [
    ...blueTeam.playerIds.map((id, index) => ({ id, team: "blue" as const, number: index + 1 })),
    ...redTeam.playerIds.map((id, index) => ({ id, team: "red" as const, number: index + 1 })),
  ];
  if (assignments.some((player) => player.id === session.hostId)) throw new Error("O professor não pode ser escalado para uma partida.");
  session.matches[bracketMatch.id] = {
    world: createMatchWorld(assignments),
    inputs: Object.fromEntries(assignments.map((player) => [player.id, { ...IDLE_INPUT }])),
    inputSequences: Object.fromEntries(assignments.map((player) => [player.id, 0])),
    tick: 0,
    bracketMatchId: bracketMatch.id,
    blueTeamId: blueTeam.id,
    redTeamId: redTeam.id,
    blueIds: [...blueTeam.playerIds],
    redIds: [...redTeam.playerIds],
    finishing: false,
    period: "firstHalf",
    periodStartsAt: Date.now(),
    periodEndsAt: Date.now() + halfDuration(),
    bonusTeamId: null,
    goldenUsedIds: [],
  };
}

function startCurrentRound() {
  if (!session?.tournament) return;
  const roundMatches = readyRoundMatches();
  if (roundMatches.length === 0) return;
  session.matches = {};
  session.quizzes = {};
  session.roundResults = [];
  for (const bracketMatch of roundMatches) createRuntimeMatch(bracketMatch);
  session.phase = "match";
  session.stageDurationMs = 0;
  session.presentation = null;
  broadcastState();
  sendSnapshots();
  schedule(beginHalftimeQuiz, halfDuration());
}

function completeRuntimeMatch(matchId: string, winnerTeamId: string) {
  if (!session?.tournament || !session.matches[matchId]) return null;
  const result = completeTournamentMatchById(session.tournament, matchId, winnerTeamId);
  session.roundResults.push({ winnerId: result.winnerId, loserId: result.loserId });
  delete session.matches[matchId];
  delete session.quizzes[matchId];
  return result;
}

function finishRound() {
  if (!session?.tournament) return;
  const onlyResult = session.roundResults.length === 1 ? session.roundResults[0] : null;
  setPresentation("bracket", DURATION.result, {
    kind: "matchResult",
    winnerTeamId: onlyResult?.winnerId,
    loserTeamId: onlyResult?.loserId ?? undefined,
    autoAdvanceTeamIds: session.tournament.autoAdvances.map((advance) => advance.teamId),
  });
  if (FAST && session.tournament.championTeamId) {
    setPresentation("champion", 0, { kind: "champion", winnerTeamId: session.tournament.championTeamId });
    return;
  }
  schedule(() => {
    if (!session?.tournament) return;
    if (session.tournament.championTeamId) {
      setPresentation("champion", 0, { kind: "champion", winnerTeamId: session.tournament.championTeamId });
    } else beginCountdown();
  }, DURATION.result);
}

function finishCurrentMatch(matchId: string, winnerTeamId: string) {
  const result = completeRuntimeMatch(matchId, winnerTeamId);
  if (!result || !session) return;
  if (Object.keys(session.matches).length === 0) finishRound();
  else { broadcastState(); sendSnapshots(); }
}

function beginHalftimeQuiz() {
  if (!session || session.phase !== "match") return;
  const matches = Object.values(session.matches).filter((match) => match.period === "firstHalf");
  if (matches.length === 0) return;
  session.phase = "quiz";
  const questions = selectQuestions(session.content.perguntas, Math.min(session.config.halftimeQuestions, session.content.perguntas.length));
  session.quizzes = {};
  for (const match of matches) {
    match.inputs = Object.fromEntries(Object.keys(match.inputs).map((id) => [id, { ...IDLE_INPUT }]));
    session.quizzes[match.bracketMatchId] = {
      mode: "halftime", questions, index: 0, stage: "answering", answers: {}, scores: {},
      questionStartedAt: Date.now(), timeLimitMs: DURATION.answer, blueScore: 0, redScore: 0, winner: null, attempt: 0, winnerPlayerId: null,
    };
  }
  session.stageDurationMs = DURATION.answer;
  session.presentation = null;
  broadcastState();
  schedule(finishQuizQuestion, DURATION.answer);
}

function finishQuizQuestion() {
  if (!session || session.phase !== "quiz") return;
  const quizzes = Object.values(session.quizzes).filter((quiz) => quiz.mode === "halftime" && quiz.stage === "answering");
  if (quizzes.length === 0) return;
  for (const quiz of quizzes) quiz.stage = "feedback";
  session.stageDurationMs = DURATION.feedback;
  broadcastState();
  schedule(nextQuizQuestion, DURATION.feedback);
}

function nextQuizQuestion() {
  if (!session) return;
  const entries = Object.entries(session.quizzes).filter(([, quiz]) => quiz.mode === "halftime");
  if (entries.length === 0) return;
  if (entries[0][1].index < entries[0][1].questions.length - 1) {
    for (const [, quiz] of entries) {
      quiz.index += 1;
      quiz.stage = "answering";
      quiz.answers = {};
      quiz.questionStartedAt = Date.now();
    }
    session.stageDurationMs = DURATION.answer;
    broadcastState();
    schedule(finishQuizQuestion, DURATION.answer);
    return;
  }
  for (const [matchId, quiz] of entries) {
    const match = session.matches[matchId];
    if (!match) continue;
    const result = teamQuizResult(quiz.scores, match.blueIds, match.redIds);
    quiz.stage = "result";
    quiz.blueScore = result.blue;
    quiz.redScore = result.red;
    quiz.winner = result.winner;
    match.bonusTeamId = result.winner === "blue" ? match.blueTeamId : result.winner === "red" ? match.redTeamId : null;
  }
  session.phase = "quizResult";
  session.stageDurationMs = DURATION.quizResult;
  broadcastState();
  schedule(beginSecondHalf, DURATION.quizResult);
}

function beginSecondHalf() {
  if (!session) return;
  const periodStartsAt = Date.now() + 5000;
  for (const match of Object.values(session.matches)) {
    resetPositions(match.world);
    match.inputs = Object.fromEntries(Object.keys(match.inputs).map((id) => [id, { ...IDLE_INPUT }]));
    match.inputSequences = Object.fromEntries(Object.keys(match.inputSequences).map((id) => [id, 0]));
    match.period = "secondHalf";
    match.periodStartsAt = periodStartsAt;
    match.periodEndsAt = periodStartsAt + halfDuration();
  }
  session.phase = "match";
  session.stageDurationMs = halfDuration();
  session.quizzes = {};
  broadcastState();
  sendSnapshots();
  schedule(finishSecondHalf, 5000 + halfDuration());
}

function finishSecondHalf() {
  if (!session || session.phase !== "match") return;
  const matches = Object.values(session.matches).filter((match) => match.period === "secondHalf");
  for (const match of matches) {
    if (match.world.scoreBlue !== match.world.scoreRed) {
      completeRuntimeMatch(match.bracketMatchId, match.world.scoreBlue > match.world.scoreRed ? match.blueTeamId : match.redTeamId);
    }
  }
  if (Object.keys(session.matches).length === 0) finishRound();
  else beginGoldenQuestion();
}

function beginGoldenQuestion() {
  if (!session) return;
  for (const match of Object.values(session.matches)) {
    const previous = session.quizzes[match.bracketMatchId];
    const unused = session.content.perguntas.filter((question) => !match.goldenUsedIds.includes(question.id));
    if (unused.length === 0) match.goldenUsedIds = [];
    const pool = unused.length > 0 ? unused : session.content.perguntas;
    const question = selectQuestions(pool, 1)[0];
    match.goldenUsedIds.push(question.id);
    session.quizzes[match.bracketMatchId] = {
      mode: "golden", questions: [question], index: 0, stage: "answering", answers: {}, scores: {},
      questionStartedAt: Date.now(), timeLimitMs: DURATION.goldenAnswer, blueScore: 0, redScore: 0,
      winner: null, attempt: (previous?.mode === "golden" ? previous.attempt : 0) + 1, winnerPlayerId: null,
    };
  }
  session.phase = "goldenQuestion";
  session.stageDurationMs = DURATION.goldenAnswer;
  broadcastState();
  schedule(finishGoldenAttempt, DURATION.goldenAnswer);
}

function finishGoldenAttempt() {
  if (!session || session.phase !== "goldenQuestion") return;
  for (const quiz of Object.values(session.quizzes)) if (quiz.mode === "golden") quiz.stage = "feedback";
  session.phase = "goldenResult";
  session.stageDurationMs = DURATION.goldenFeedback;
  broadcastState();
  schedule(beginGoldenQuestion, DURATION.goldenFeedback);
}

function winGoldenQuestion(playerId: string) {
  if (!session) return;
  const match = Object.values(session.matches).find((item) => item.blueIds.includes(playerId) || item.redIds.includes(playerId));
  if (!match) return;
  const quiz = session.quizzes[match.bracketMatchId];
  if (!quiz) return;
  const team = match.blueIds.includes(playerId) ? "blue" : "red";
  quiz.stage = "feedback";
  quiz.winner = team;
  quiz.winnerPlayerId = playerId;
  session.stageDurationMs = DURATION.goldenFeedback;
  broadcastState();
  const winnerTeamId = team === "blue" ? match.blueTeamId : match.redTeamId;
  setTimeout(() => {
    completeRuntimeMatch(match.bracketMatchId, winnerTeamId);
    if (!session) return;
    if (Object.keys(session.matches).length === 0) finishRound();
    else { broadcastState(); sendSnapshots(); }
  }, DURATION.goldenFeedback);
}

function beginTournamentFlow() {
  if (!session) return;
  const students = session.players.filter((player) => !player.isHost);
  session.educationStats = Object.fromEntries(students.map((player) => [player.id, { answered: 0, correct: 0, points: 0, goldenWins: 0 }]));
  session.tournament = createTournament(students.map((player) => player.id));
  session.matches = {};
  session.quizzes = {};
  session.viewingMatchByClient = {};
  session.roundResults = [];
  setPresentation("summary", summaryDuration(), { kind: "summary" });
  schedule(() => {
    setPresentation("draw", DURATION.draw, { kind: "draw" });
    schedule(() => {
      if (!session?.tournament) return;
      setPresentation("bracket", DURATION.bracket, {
        kind: "initialBracket",
        autoAdvanceTeamIds: session.tournament.autoAdvances.map((advance) => advance.teamId),
      });
      schedule(beginCountdown, DURATION.bracket);
    }, DURATION.draw);
  }, summaryDuration());
}

function startTournamentFromLobby() {
  if (!session || session.phase !== "lobby") throw new Error("O campeonato já foi iniciado.");
  const onlineStudents = session.players.filter((player) => player.online && !player.isHost);
  if (onlineStudents.length < MIN_PLAYERS) throw new Error("São necessários pelo menos 4 alunos ou bots conectados.");
  session.players = session.players.filter((player) => player.isHost || player.online);
  beginTournamentFlow();
}

function setBotCount(requested: number) {
  if (!session || session.phase !== "lobby") throw new Error("Bots só podem ser configurados no lobby.");
  const humans = session.players.filter((player) => !player.isHost && !player.isBot);
  const allowed = Math.min(31, Math.max(0, session.config.maxPlayers - humans.length));
  const count = Math.min(allowed, Math.max(0, Math.trunc(requested)));
  session.players = session.players.filter((player) => !player.isBot);
  for (let index = 0; index < count; index += 1) {
    session.players.push({ id: `bot-${index + 1}`, nickname: `Bot ${String(index + 1).padStart(2, "0")}`, online: true, isHost: false, isBot: true });
  }
  broadcastState();
  return `${count} bot${count === 1 ? "" : "s"} no lobby${count < requested ? ` (limite atual: ${allowed})` : ""}.`;
}

function shutdownServer() {
  broadcast({ type: "serverClosed", message: CLOUD_MODE ? "O professor encerrou a sala FuteSenai." : "O professor encerrou o servidor FuteSenai." });
  if (transitionTimer) clearTimeout(transitionTimer);
  setTimeout(() => {
    for (const socket of clients.values()) socket.close(1001, CLOUD_MODE ? "Sala encerrada pelo professor" : "Servidor encerrado pelo professor");
    clients.clear();
    if (CLOUD_MODE) {
      session = null;
      return;
    }
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }, 120).unref();
}

function runAdminCommand(commandText: string, clientId: string) {
  if (!session) throw new Error("Não existe sala ativa.");
  const [name = "", ...args] = commandText.trim().toLowerCase().split(/\s+/);
  if (["/help", "help", "/ajuda", "ajuda"].includes(name)) return "/bots N · /clearbots · /goal blue|red · /win blue|red · /golden · /reset · /kick NOME · /start · /encerrar servidor";
  if (name === "/bots") return setBotCount(Number(args[0] ?? 0));
  if (name === "/clearbots") return setBotCount(0);
  if (name === "/start") { startTournamentFromLobby(); return "Campeonato iniciado."; }
  if (["/close", "close", "/shutdown", "shutdown", "/encerrar", "encerrar", "/encerrar-servidor", "encerrar-servidor", "/fechar", "fechar"].includes(name)) {
    shutdownServer(); return "Encerrando servidor e desconectando a turma...";
  }
  if (name === "/kick") {
    if (session.phase !== "lobby") throw new Error("Remova jogadores somente no lobby.");
    const query = args.join(" ");
    const player = session.players.find((item) => !item.isHost && item.nickname.toLowerCase() === query);
    if (!player) throw new Error("Jogador não encontrado.");
    session.players = session.players.filter((item) => item.id !== player.id);
    const target = clients.get(player.id); if (target) target.close(1008, "Removido pelo administrador");
    broadcastState(); return `${player.nickname} removido.`;
  }
  const match = runtimeMatchForClient(clientId);
  if (!match) throw new Error("Este comando precisa de uma partida ativa.");
  if (name === "/goal") {
    if (args[0] === "blue") match.world.scoreBlue += 1;
    else if (args[0] === "red") match.world.scoreRed += 1;
    else throw new Error("Use /goal blue ou /goal red.");
    sendSnapshots(); return `Gol adicionado ao time ${args[0]}.`;
  }
  if (name === "/win") {
    const winner = args[0] === "red" ? match.redTeamId : args[0] === "blue" ? match.blueTeamId : null;
    if (!winner) throw new Error("Use /win blue ou /win red.");
    finishCurrentMatch(match.bracketMatchId, winner); return `Vitória do time ${args[0]}.`;
  }
  if (name === "/golden") {
    for (const active of Object.values(session.matches)) { active.world.scoreBlue = 0; active.world.scoreRed = 0; active.period = "secondHalf"; }
    beginGoldenQuestion();
    return "Pergunta de ouro iniciada.";
  }
  if (name === "/reset") { resetPositions(match.world); sendSnapshots(); return "Posições reiniciadas."; }
  throw new Error("Comando desconhecido. Use /help.");
}

function updateBotInputs(match: MatchState) {
  const ball = match.world.discs.find((body) => body.team === "ball");
  if (!ball || !session) return;
  for (const id of [...match.blueIds, ...match.redIds]) {
    const player = session.players.find((item) => item.id === id);
    if (!player?.isBot) continue;
    const body = match.world.discs.find((item) => item.id === id);
    if (!body) continue;
    const teamIds = body.team === "blue" ? match.blueIds : match.redIds;
    const secondPlayer = teamIds.indexOf(id) === 1;
    const defendX = body.team === "blue" ? 300 : 660;
    const ballThreatens = body.team === "blue" ? ball.x < 500 : ball.x > 460;
    const targetX = secondPlayer && !ballThreatens ? defendX : ball.x;
    const targetY = secondPlayer && !ballThreatens ? 315 : ball.y;
    const dx = targetX - body.x; const dy = targetY - body.y;
    const distanceToBall = Math.hypot(ball.x - body.x, ball.y - body.y);
    match.inputs[id] = { left: dx < -5, right: dx > 5, up: dy < -5, down: dy > 5, kick: distanceToBall <= body.radius + ball.radius + 8 };
  }
}

function snapshotPayload(match: MatchState) {
  const now = Date.now();
  return {
    type: "snapshot",
    matchId: match.bracketMatchId,
    tick: match.tick,
    scoreBlue: match.world.scoreBlue,
    scoreRed: match.world.scoreRed,
    goalFlash: match.world.goalFlash,
    lastGoal: match.world.lastGoal,
    bodies: match.world.discs.map((body) => ({ ...body, controlled: undefined })),
    actions: match.world.actions,
    period: match.period,
    timeRemainingMs: Math.max(0, match.periodEndsAt - Math.max(now, match.periodStartsAt)),
    periodStartsInMs: Math.max(0, match.periodStartsAt - now),
    bonusTeamId: match.bonusTeamId,
    kickoffActive: match.world.kickoffActive,
    processedInputs: match.inputSequences,
    serverTime: Date.now(),
    physicsHz: PHYSICS_HZ,
  };
}

const gateway = createServer((request, response) => {
  const proxy = httpRequest({
    hostname: "127.0.0.1",
    port: WEB_PORT,
    method: request.method,
    path: request.url,
    headers: request.headers,
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "2" });
    }
    response.end("FuteSenai está iniciando. Atualize a página em alguns segundos.");
  });
  request.pipe(proxy);
});
const wss = new WebSocketServer({ noServer: true });

gateway.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit("connection", webSocket, request);
  });
});

try { os.setPriority(0, os.constants.priority.PRIORITY_HIGH); } catch { /* prioridade opcional no Windows */ }

wss.on("connection", (socket, request) => {
  let connectedClientId: string | null = null;
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  if (!detectedPublicUrl && forwardedHost) detectedPublicUrl = `${forwardedProto || (CLOUD_MODE ? "https" : "http")}://${forwardedHost}`;
  send(socket, { type: "state", state: publicState() });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      const clientId = String(message.clientId ?? "");
      if (!clientId || clientId.length > 80) throw new Error("Identificador do jogador inválido.");
      if (connectedClientId && connectedClientId !== clientId) throw new Error("Identidade da conexão inválida.");
      connectedClientId = clientId;
      clients.set(clientId, socket);

      if (message.type === "ping") {
        send(socket, { type: "pong", clientSentAt: Number(message.clientSentAt) || 0, serverAt: Date.now() });
        return;
      }
      if (message.type === "resume") {
        send(socket, { type: "role", canCreateRoom: hasProfessorAccess(message.professorKey) });
        const player = session?.players.find((item) => item.id === clientId);
        if (player && !player.isBot) player.online = true;
        broadcastState();
        const match = runtimeMatchForClient(clientId);
        if (match) send(socket, snapshotPayload(match));
        return;
      }
      if (message.type === "create") {
        if (!hasProfessorAccess(message.professorKey)) throw new Error("Chave do professor inválida.");
        if (session) throw new Error("Já existe uma sala criada neste servidor.");
        const nickname = cleanNickname(message.nickname);
        if (!nickname) throw new Error("Digite o nickname do professor.");
        const content = normalizeContent(message.content);
        const config = resolveConfig(message.config);
        if (config.halftimeQuestions > content.perguntas.length) throw new Error(`O JSON precisa ter ao menos ${config.halftimeQuestions} perguntas.`);
        const adminToken = randomBytes(24).toString("hex");
        session = { phase: "lobby", hostId: clientId, adminToken, content, config, players: [{ id: clientId, nickname, online: true, isHost: true, isBot: false }], tournament: null, matches: {}, presentation: null, quizzes: {}, viewingMatchByClient: {}, roundResults: [], educationStats: {}, stageDurationMs: 0 };
        send(socket, { type: "created", hostId: clientId, adminToken }); broadcastState(); return;
      }
      if (message.type === "join") {
        if (!session) throw new Error("O professor ainda não criou a sala.");
        if (session.phase !== "lobby") throw new Error("As inscrições para esta sala estão encerradas.");
        const nickname = cleanNickname(message.nickname);
        if (!nickname) throw new Error("Escolha um nickname.");
        const duplicateName = session.players.some((player) => player.nickname.toLowerCase() === nickname.toLowerCase() && player.id !== clientId);
        if (duplicateName) throw new Error("Este nickname já está sendo usado.");
        let player = session.players.find((item) => item.id === clientId);
        if (!player) {
          const studentCount = session.players.filter((item) => !item.isHost).length;
          if (studentCount >= session.config.maxPlayers) throw new Error(`O lobby atingiu o limite de ${session.config.maxPlayers} alunos.`);
          player = { id: clientId, nickname, online: true, isHost: false, isBot: false };
          session.players.push(player);
        } else { player.nickname = nickname; player.online = true; }
        send(socket, { type: "joined", playerId: clientId }); broadcastState(); return;
      }
      if (message.type === "removePlayer") {
        assertHost(clientId, message.adminToken);
        if (!session || message.playerId === session.hostId) throw new Error("O professor não pode ser removido.");
        session.players = session.players.filter((player) => player.id !== message.playerId);
        const removedSocket = clients.get(String(message.playerId));
        if (removedSocket) send(removedSocket, { type: "error", message: "Você foi removido da sala pelo professor." });
        broadcastState(); return;
      }
      if (message.type === "start") {
        assertHost(clientId, message.adminToken);
        startTournamentFromLobby();
        return;
      }
      if (message.type === "chat") {
        if (!session) return;
        const player = session.players.find((item) => item.id === clientId && item.online);
        if (!player || player.isBot) return;
        const text = String(message.text ?? "").replace(/[<>]/g, "").split("").filter((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        }).join("").trim().slice(0, 160);
        if (!text) return;
        const match = Object.values(session.matches).find((item) => item.blueIds.includes(clientId) || item.redIds.includes(clientId));
        const team = match?.blueIds.includes(clientId) ? "blue" : match?.redIds.includes(clientId) ? "red" : "spectator";
        broadcast({ type: "chat", message: { id: `${Date.now()}-${clientId.slice(0, 8)}`, playerId: clientId, nickname: player.nickname, text, team, sentAt: Date.now() } });
        return;
      }
      if (message.type === "input") {
        if (session?.hostId === clientId) return;
        const match = Object.values(session?.matches ?? {}).find((item) => item.inputs[clientId]);
        if (!match) return;
        const sequence = Math.max(0, Math.trunc(Number(message.sequence) || 0));
        if (sequence <= (match.inputSequences[clientId] ?? 0)) return;
        match.inputSequences[clientId] = sequence;
        match.inputs[clientId] = sanitizeInput(message.input);
        return;
      }
      if (message.type === "answer") {
        if (session?.hostId === clientId) return;
        const match = Object.values(session?.matches ?? {}).find((item) => item.blueIds.includes(clientId) || item.redIds.includes(clientId));
        if (!session || !match || !["quiz", "goldenQuestion"].includes(session.phase)) return;
        const quiz = session.quizzes[match.bracketMatchId];
        if (!quiz || quiz.stage !== "answering") return;
        if (clientId in quiz.answers) return;
        const choice = Number(message.choice);
        if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
        const question = quiz.questions[quiz.index];
        quiz.answers[clientId] = choice;
        const stats = session.educationStats[clientId] ?? (session.educationStats[clientId] = { answered: 0, correct: 0, points: 0, goldenWins: 0 });
        stats.answered += 1;
        if (quiz.mode === "golden") {
          if (choice === question.correta) { stats.correct += 1; stats.points += 150; stats.goldenWins += 1; }
          broadcastState();
          if (choice === question.correta) winGoldenQuestion(clientId);
          else if (Object.entries(session.quizzes).filter(([, item]) => item.mode === "golden").every(([id, item]) => {
            const active = session!.matches[id];
            return active && [...active.blueIds, ...active.redIds].every((player) => player in item.answers);
          })) finishGoldenAttempt();
          return;
        }
        const elapsed = Date.now() - quiz.questionStartedAt;
        const earned = scoreAnswer(choice === question.correta, elapsed, quiz.timeLimitMs);
        if (choice === question.correta) stats.correct += 1;
        stats.points += earned;
        quiz.scores[clientId] = (quiz.scores[clientId] ?? 0) + earned;
        broadcastState();
        if (Object.entries(session.quizzes).filter(([, item]) => item.mode === "halftime").every(([id, item]) => {
          const active = session!.matches[id];
          return active && [...active.blueIds, ...active.redIds].every((player) => player in item.answers);
        })) finishQuizQuestion();
        return;
      }
      if (message.type === "watchMatch") {
        if (!session || !canSelectMatch(clientId)) throw new Error("Você deve acompanhar a sua própria partida enquanto estiver jogando.");
        const matchId = String(message.matchId ?? "");
        if (!matchId) {
          delete session.viewingMatchByClient[clientId];
          send(socket, { type: "state", state: publicState(clientId) });
          return;
        }
        const available = availableMatches().some((match) => match.matchId === matchId);
        if (!available) throw new Error("Esta partida não está disponível para assistir.");
        session.viewingMatchByClient[clientId] = matchId;
        send(socket, { type: "state", state: publicState(clientId) });
        const match = session.matches[matchId];
        if (match) send(socket, snapshotPayload(match));
        return;
      }
      if (message.type === "debugFinish") {
        assertHost(clientId, message.adminToken);
        const match = runtimeMatchForClient(clientId);
        if (!match) throw new Error("Não existe partida ativa.");
        const requested = message.team === "red" ? match.redTeamId : match.blueTeamId;
        finishCurrentMatch(match.bracketMatchId, requested);
        return;
      }
      if (message.type === "debugGolden") {
        assertHost(clientId, message.adminToken);
        if (!session || Object.keys(session.matches).length === 0) throw new Error("Não existe partida ativa.");
        for (const match of Object.values(session.matches)) { match.world.scoreBlue = 0; match.world.scoreRed = 0; match.period = "secondHalf"; }
        beginGoldenQuestion();
        return;
      }
      if (message.type === "adminCommand") {
        assertHost(clientId, message.adminToken);
        const result = runAdminCommand(String(message.command ?? ""), clientId);
        send(socket, { type: "adminResult", message: result });
        return;
      }
      if (message.type === "shutdown") {
        assertHost(clientId, message.adminToken);
        shutdownServer();
        return;
      }
      if (message.type === "restartTournament") {
        assertHost(clientId, message.adminToken);
        if (!session?.tournament?.championTeamId) throw new Error("O campeonato ainda não terminou.");
        if (transitionTimer) clearTimeout(transitionTimer);
        session.phase = "lobby";
        session.tournament = null;
        session.matches = {};
        session.presentation = null;
        session.quizzes = {};
        session.viewingMatchByClient = {};
        session.roundResults = [];
        session.stageDurationMs = 0;
        broadcastState();
        return;
      }
      throw new Error("Comando desconhecido.");
    } catch (error) {
      fail(socket, error instanceof Error ? error.message : "Não foi possível processar a ação.");
    }
  });

  socket.on("close", () => {
    if (!connectedClientId) return;
    if (clients.get(connectedClientId) === socket) clients.delete(connectedClientId);
    const player = session?.players.find((item) => item.id === connectedClientId);
    if (player && !player.isBot) player.online = false;
    for (const match of Object.values(session?.matches ?? {})) if (match.inputs[connectedClientId]) match.inputs[connectedClientId] = { ...IDLE_INPUT };
    broadcastState();
  });
});

const FIXED_PHYSICS_STEP = 1 / PHYSICS_HZ;
let physicsAccumulator = 0;
let previousPhysicsTime = performance.now();
const physicsTimer = setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(.05, Math.max(0, (now - previousPhysicsTime) / 1000));
  previousPhysicsTime = now;
  if (!session || session.phase !== "match") {
    physicsAccumulator = 0;
    return;
  }
  physicsAccumulator += elapsed;
  let steps = 0;
  while (physicsAccumulator >= FIXED_PHYSICS_STEP && steps < 3) {
    for (const match of Object.values(session.matches)) {
      if (match.finishing) continue;
      if (Date.now() < match.periodStartsAt) continue;
      updateBotInputs(match);
      const bonusIds = match.bonusTeamId === match.blueTeamId ? match.blueIds : match.bonusTeamId === match.redTeamId ? match.redIds : [];
      const boosted = { ...DEFAULT_PHYSICS, acceleration: DEFAULT_PHYSICS.acceleration * 1.12, maxSpeed: DEFAULT_PHYSICS.maxSpeed * 1.08, kickForce: DEFAULT_PHYSICS.kickForce * 1.15 };
      const perPlayer = Object.fromEntries(bonusIds.map((id) => [id, boosted]));
      stepMultiplayerWorld(match.world, match.inputs, DEFAULT_PHYSICS, FIXED_PHYSICS_STEP, perPlayer);
      match.tick += 1;
    }
    physicsAccumulator -= FIXED_PHYSICS_STEP;
    steps += 1;
  }
  // O snapshot sai do mesmo relógio da física: nunca existe um estado visual
  // intermediário ou atrasado em relação ao passo que resolveu a bola.
  if (steps > 0) sendSnapshots();
}, 4);

gateway.on("close", () => { clearInterval(physicsTimer); if (transitionTimer) clearTimeout(transitionTimer); });
gateway.listen(PORT, "0.0.0.0", () => {
  console.log(`FuteSenai online em http://0.0.0.0:${PORT}`);
  console.log(`WebSocket disponível em /ws; frontend interno na porta ${WEB_PORT}.`);
});
