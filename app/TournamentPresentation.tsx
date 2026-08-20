"use client";

import Image from "next/image";
import { useEffect, type CSSProperties } from "react";
import type { Tournament, TournamentTeam } from "../game/tournament";
import { playAdvance, playChampion, playWhistle } from "./gameAudio";
import { SoundToggle } from "./SoundToggle";

type Player = { id: string; nickname: string; online: boolean; isHost: boolean; isBot: boolean };
type RoomSettings = { summaryDurationMs: number; matchDurationMs: number; halftimeQuestions: number; maxPlayers: number };
type MatchInfo = { matchId: string; round: number; blueTeamId: string; redTeamId: string; blueIds: string[]; redIds: string[] };
type EducationResult = { playerId: string; nickname: string; answered: number; correct: number; points: number; goldenWins: number; accuracy: number };
type Presentation = {
  id: number;
  kind: "summary" | "draw" | "initialBracket" | "matchResult" | "countdown" | "champion";
  winnerTeamId?: string;
  loserTeamId?: string;
  autoAdvanceTeamIds?: string[];
};

function roundName(round: number, roundCount: number) {
  const distanceToFinal = roundCount - round;
  if (distanceToFinal === 1) return "Final";
  if (distanceToFinal === 2) return "Semifinais";
  if (distanceToFinal === 3) return "Quartas de final";
  return "Oitavas de final";
}

function teamName(team: TournamentTeam | undefined, players: Player[]) {
  if (!team) return "SEM TIME";
  return team.playerIds.map((id) => players.find((player) => player.id === id)?.nickname ?? "Jogador").join(" + ");
}

function StageProgress({ id, duration }: { id: number; duration: number }) {
  if (!duration) return null;
  return <div className="stage-progress" key={id}><span style={{ animationDuration: `${duration}ms` }} /></div>;
}

function ClassicBracketView({ tournament, players, presentation }: { tournament: Tournament; players: Player[]; presentation: Presentation }) {
  const autoIds = new Set(presentation.autoAdvanceTeamIds ?? []);
  return (
    <div className="bracket-board" style={{ gridTemplateColumns: `repeat(${tournament.roundCount}, minmax(210px, 1fr))` }}>
      {Array.from({ length: tournament.roundCount }, (_, round) => round).map((round) => {
        const matches = tournament.matches.filter((match) => match.round === round);
        const name = roundName(round, tournament.roundCount);
        return (
          <section className={`bracket-round round-${round}`} key={name}>
            <header><span>{String(round + 1).padStart(2, "0")}</span><strong>{name}</strong><small>{matches.length} {matches.length === 1 ? "jogo" : "jogos"}</small></header>
            <div className="round-matches">
              {matches.map((match, index) => {
                const teamA = tournament.teams.find((team) => team.id === match.teamAId);
                const teamB = tournament.teams.find((team) => team.id === match.teamBId);
                const classFor = (teamId: string | null) => [
                  "bracket-team",
                  match.winnerId === teamId && teamId ? "winner" : "",
                  match.loserId === teamId && teamId ? "loser" : "",
                  presentation.winnerTeamId === teamId ? "just-won" : "",
                  presentation.loserTeamId === teamId ? "just-lost" : "",
                  teamId && autoIds.has(teamId) ? "auto-advanced" : "",
                  !teamId ? "vacant" : "",
                ].filter(Boolean).join(" ");
                return (
                  <article className={`bracket-match ${tournament.currentMatchId === match.id ? "next-match" : ""}`} key={match.id} style={{ "--delay": `${index * 90}ms` } as CSSProperties}>
                    <div className={classFor(match.teamAId)}><span>{teamA ? teamName(teamA, players) : match.status === "pending" ? "A DEFINIR" : "SEM TIME"}</span>{match.winnerId === match.teamAId && <b>✓</b>}</div>
                    <div className={classFor(match.teamBId)}><span>{teamB ? teamName(teamB, players) : match.status === "pending" ? "A DEFINIR" : "SEM TIME"}</span>{match.winnerId === match.teamBId && <b>✓</b>}</div>
                    <small>{match.status === "bye" ? "AVANÇO AUTOMÁTICO" : match.status === "finished" ? "ENCERRADO" : tournament.currentMatchId === match.id ? "PRÓXIMO" : match.id.toUpperCase()}</small>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function WorldCupBracketView({ tournament, players, presentation }: { tournament: Tournament; players: Player[]; presentation: Presentation }) {
  const autoIds = new Set(presentation.autoAdvanceTeamIds ?? []);
  const finalRound = tournament.roundCount - 1;
  const card = (match: Tournament["matches"][number], index: number, side: "left" | "right" | "final") => {
    const teamA = tournament.teams.find((team) => team.id === match.teamAId);
    const teamB = tournament.teams.find((team) => team.id === match.teamBId);
    const classFor = (teamId: string | null) => [
      "bracket-team",
      match.winnerId === teamId && teamId ? "winner" : "",
      match.loserId === teamId && teamId ? "loser" : "",
      presentation.winnerTeamId === teamId ? "just-won" : "",
      presentation.loserTeamId === teamId ? "just-lost" : "",
      teamId && autoIds.has(teamId) ? "auto-advanced" : "",
      !teamId ? "vacant" : "",
    ].filter(Boolean).join(" ");
    return (
      <article className={`world-bracket-match ${side} ${tournament.currentMatchId === match.id ? "next-match" : ""}`} key={match.id} style={{ "--delay": `${index * 70}ms` } as CSSProperties}>
        <div className={classFor(match.teamAId)}><span>{teamA ? teamName(teamA, players) : match.status === "pending" ? "A DEFINIR" : "SEM TIME"}</span>{match.winnerId === match.teamAId && <b>✓</b>}</div>
        <div className={classFor(match.teamBId)}><span>{teamB ? teamName(teamB, players) : match.status === "pending" ? "A DEFINIR" : "SEM TIME"}</span>{match.winnerId === match.teamBId && <b>✓</b>}</div>
        <small>{match.status === "bye" ? "AVANÇOU" : match.status === "finished" ? "ENCERRADO" : tournament.currentMatchId === match.id ? "PRÓXIMO" : match.id.toUpperCase()}</small>
      </article>
    );
  };
  const rounds = Array.from({ length: Math.max(0, finalRound) }, (_, round) => round);
  const finalMatch = tournament.matches.find((match) => match.round === finalRound);
  const sideRound = (round: number, side: "left" | "right") => {
    const matches = tournament.matches.filter((match) => match.round === round);
    const split = Math.ceil(matches.length / 2);
    const selected = side === "left" ? matches.slice(0, split) : matches.slice(split);
    return (
      <section className={`world-bracket-round ${side} round-${round}`} key={`${side}-${round}`} style={{ "--match-count": Math.max(1, selected.length) } as CSSProperties}>
        <header><strong>{roundName(round, tournament.roundCount)}</strong><span>{selected.length} {selected.length === 1 ? "jogo" : "jogos"}</span></header>
        <div>{selected.map((match, index) => card(match, index, side))}</div>
      </section>
    );
  };
  return (
    <div className="world-bracket-shell" style={{ "--side-rounds": Math.max(1, rounds.length) } as CSSProperties}>
      <div className="world-bracket-title"><span>CAMINHO ATÉ O TÍTULO 🏆</span><strong>FuteSenai · Mata-mata</strong></div>
      <div className="world-bracket-board">
        <div className="world-bracket-wing left-wing">{rounds.map((round) => sideRound(round, "left"))}</div>
        <section className="world-bracket-final"><span>🏆 A GRANDE FINAL</span>{finalMatch ? card(finalMatch, 0, "final") : <strong>A DEFINIR</strong>}<i>★</i></section>
        <div className="world-bracket-wing right-wing">{[...rounds].reverse().map((round) => sideRound(round, "right"))}</div>
      </div>
    </div>
  );
}

export function TournamentPresentation({
  phase,
  title,
  summary,
  players,
  tournament,
  match,
  presentation,
  stageDurationMs,
  educationResults,
  settings,
  isHost,
  onRestart,
}: {
  phase: "summary" | "draw" | "bracket" | "countdown" | "champion";
  title: string;
  summary: string;
  players: Player[];
  tournament: Tournament;
  match: MatchInfo | null;
  presentation: Presentation;
  stageDurationMs: number;
  educationResults: EducationResult[];
  settings: RoomSettings | null;
  isHost: boolean;
  onRestart: () => void;
}) {
  const teamById = (id?: string) => tournament.teams.find((team) => team.id === id);
  const excluded = players.find((player) => player.id === tournament.excludedPlayerId);
  useEffect(() => {
    if (phase === "countdown") playWhistle();
    if (phase === "bracket" && presentation.kind === "matchResult") playAdvance();
    if (phase === "champion") playChampion();
  }, [phase, presentation.id, presentation.kind]);

  if (phase === "summary") {
    return (
      <main className="presentation-page summary-stage">
        <header className="presentation-brand"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai</span><SoundToggle /></header>
        <section className="summary-content"><span className="presentation-kicker">📚 REVISÃO ANTES DO CAMPEONATO</span><h1>{title}</h1><div className="summary-text">{summary}</div><small>Leia com atenção. Este conteúdo aparecerá nas perguntas.</small></section>
        <StageProgress id={presentation.id} duration={stageDurationMs} />
      </main>
    );
  }

  if (phase === "draw") {
    return (
      <main className="presentation-page draw-stage">
        <header className="presentation-top"><div><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai</span></div><p><strong>{tournament.teams.length}</strong> DUPLAS SORTEADAS</p><SoundToggle /></header>
        <section className="draw-content"><span className="presentation-kicker">🎲 SORTEIO CONCLUÍDO</span><h1>As duplas do campeonato</h1><div className="draw-team-grid">{tournament.teams.map((team, index) => <article key={team.id} style={{ "--delay": `${index * 130}ms` } as CSSProperties}><span className="team-seed">{String(index + 1).padStart(2, "0")}</span><div>{team.playerIds.map((id, playerIndex) => <p key={id}><i>{players.find((player) => player.id === id)?.nickname.slice(0, 1).toUpperCase()}</i><strong>{players.find((player) => player.id === id)?.nickname}</strong>{playerIndex === 0 && <b>+</b>}</p>)}</div></article>)}</div>{excluded && <div className="excluded-player"><span>👀 ESPECTADOR</span><strong>{excluded.nickname}</strong><p>Último inscrito sem dupla por quantidade ímpar.</p></div>}</section>
        <StageProgress id={presentation.id} duration={stageDurationMs} />
      </main>
    );
  }

  if (phase === "countdown" && match) {
    const blue = teamById(match.blueTeamId);
    const red = teamById(match.redTeamId);
    return (
      <main className="presentation-page versus-stage">
        <header className="presentation-brand"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai</span><SoundToggle /></header>
        <section><span className="presentation-kicker">⚽ PRÓXIMA PARTIDA · {roundName(match.round, tournament.roundCount)}</span><div className="versus-teams"><article className="blue"><span>TIME AZUL</span><h2>{teamName(blue, players)}</h2></article><strong>VS</strong><article className="red"><span>TIME VERMELHO</span><h2>{teamName(red, players)}</h2></article></div><p className="match-rule-note">Partida de {Math.round((settings?.matchDurationMs ?? 120000) / 6000) / 10} min · {settings?.halftimeQuestions ?? 5} perguntas no intervalo · pergunta de ouro em caso de empate.</p><div className="countdown-pulse">⚡ PREPAREM-SE</div></section>
        <StageProgress id={presentation.id} duration={stageDurationMs} />
      </main>
    );
  }

  if (phase === "champion") {
    const champion = teamById(tournament.championTeamId ?? presentation.winnerTeamId);
    const ranking = [...educationResults].filter((result) => result.answered > 0).sort((a, b) => b.points - a.points || b.accuracy - a.accuracy).slice(0, 8);
    return (
      <main className="presentation-page champion-stage">
        <div className="champion-rays" /><header className="presentation-brand"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai</span><SoundToggle /></header>
        <section className="champion-content"><div className="champion-summary"><span className="champion-cup">★</span><span className="presentation-kicker">🏆 CAMPEÕES DO FUTESENAI</span><h1>{teamName(champion, players)}</h1><p>Da sala de aula para o topo do campeonato.</p><div className="champion-players">{champion?.playerIds.map((id) => <span key={id}>{players.find((player) => player.id === id)?.nickname}</span>)}</div></div>
          <div className="education-report"><div className="report-heading"><h2>📊 Desempenho educacional</h2><span>{ranking.length} participantes com respostas</span></div><div className="report-table"><div className="report-row header"><span>Aluno</span><span>Acertos</span><span>Aproveitamento</span><span>Pontos</span></div>{ranking.map((result, index) => <div className="report-row" key={result.playerId}><span><b>{index + 1}</b>{result.nickname}{result.goldenWins > 0 && <i title="Venceu uma pergunta de ouro">★</i>}</span><span>{result.correct}/{result.answered}</span><span>{result.accuracy}%</span><strong>{result.points}</strong></div>)}</div></div>
          {isHost ? <button className="restart-button" type="button" onClick={onRestart}>Voltar ao lobby e jogar novamente</button> : <p className="restart-waiting">Aguardando o professor iniciar outro campeonato.</p>}
        </section>
      </main>
    );
  }

  const winner = teamById(presentation.winnerTeamId);
  const loser = teamById(presentation.loserTeamId);
  return (
    <main className="presentation-page bracket-stage">
      <header className="presentation-top"><div><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><span>FuteSenai</span></div>{presentation.kind === "matchResult" && winner ? <div className="result-banner"><span>✅ CLASSIFICADOS</span><strong>{teamName(winner, players)}</strong>{loser && <small>❌ {teamName(loser, players)} · eliminados</small>}</div> : <div className="result-banner initial"><span>🏆 CHAVEAMENTO DEFINIDO</span><strong>Mata-mata FuteSenai</strong><small>{tournament.autoAdvances.length > 0 ? `⏩ ${tournament.autoAdvances.length} avanços automáticos` : "⚽ Todos começam na primeira rodada"}</small></div>}<SoundToggle /></header>
      <div className="classic-bracket-layout"><ClassicBracketView tournament={tournament} players={players} presentation={presentation} /></div>
      <div className="world-cup-bracket-layout"><WorldCupBracketView tournament={tournament} players={players} presentation={presentation} /></div>
      <StageProgress id={presentation.id} duration={stageDurationMs} />
    </main>
  );
}
