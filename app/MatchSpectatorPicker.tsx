"use client";

import Image from "next/image";
import { SoundToggle } from "./SoundToggle";

export type WatchableMatch = {
  matchId: string;
  round: number;
  blueTeamId: string;
  redTeamId: string;
  blueIds: string[];
  redIds: string[];
  stage: "playing" | "halftime" | "golden";
};

type Player = { id: string; nickname: string };

function names(ids: string[], players: Player[]) {
  return ids.map((id) => players.find((player) => player.id === id)?.nickname ?? "Jogador").join(" + ");
}

export function MatchSpectatorPicker({ matches, selectedId, players, onSelect, onLeave }: {
  matches: WatchableMatch[];
  selectedId: string | null;
  players: Player[];
  onSelect: (matchId: string) => void;
  onLeave?: () => void;
}) {
  if (matches.length === 0) return null;
  return (
    <aside className="watch-picker" aria-label="Escolher partida para assistir">
      <header><span>PARTIDAS DA RODADA</span><strong>Escolha onde assistir</strong>{onLeave && <button className="watch-picker-back" type="button" onClick={onLeave}>Central</button>}</header>
      <div>
        {matches.map((match, index) => (
          <button className={match.matchId === selectedId ? "selected" : ""} type="button" key={match.matchId} onClick={() => onSelect(match.matchId)}>
            <i>{String(index + 1).padStart(2, "0")}</i>
            <span><b>{names(match.blueIds, players)}</b><small>×</small><b>{names(match.redIds, players)}</b></span>
            <em className={match.stage}>{match.stage === "golden" ? "OURO" : match.stage === "halftime" ? "INTERVALO" : "AO VIVO"}</em>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function MatchBroadcastLobby({ matches, players, onSelect, isHost }: {
  matches: WatchableMatch[];
  players: Player[];
  onSelect: (matchId: string) => void;
  isHost: boolean;
}) {
  return (
    <main className="broadcast-lobby">
      <header className="broadcast-header"><div><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} priority /><strong>FuteSenai</strong></div><span>Central de transmissões</span><SoundToggle /></header>
      <section className="broadcast-content">
        <div className="broadcast-heading"><span>{isHost ? "VISÃO DO PROFESSOR" : "ÁREA DO ESPECTADOR"}</span><h1>Qual partida você quer acompanhar?</h1><p>Nenhum campo é carregado até você escolher. Troque de transmissão quando quiser.</p></div>
        <div className="broadcast-grid">
          {matches.map((match, index) => (
            <button type="button" key={match.matchId} onClick={() => onSelect(match.matchId)}>
              <span className="broadcast-number">JOGO {String(index + 1).padStart(2, "0")}</span>
              <div><strong>{names(match.blueIds, players)}</strong><i>×</i><strong>{names(match.redIds, players)}</strong></div>
              <em className={match.stage}>{match.stage === "golden" ? "PERGUNTA DE OURO" : match.stage === "halftime" ? "INTERVALO" : "ASSISTIR AO VIVO"}</em>
            </button>
          ))}
        </div>
        {matches.length === 0 && <div className="broadcast-empty"><strong>Aguardando as partidas</strong><span>A próxima fase será exibida aqui assim que começar.</span></div>}
      </section>
    </main>
  );
}
