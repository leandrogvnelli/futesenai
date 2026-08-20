export type TeamStatus = "active" | "eliminated" | "champion";
export type MatchStatus = "pending" | "waiting" | "playing" | "finished" | "bye" | "empty";

export type TournamentTeam = {
  id: string;
  playerIds: [string, string];
  status: TeamStatus;
  slot: number;
};

export type BracketMatch = {
  id: string;
  round: number;
  index: number;
  sourceAId: string | null;
  sourceBId: string | null;
  teamAId: string | null;
  teamBId: string | null;
  winnerId: string | null;
  loserId: string | null;
  status: MatchStatus;
  resolved: boolean;
};

export type AutoAdvance = { matchId: string; teamId: string; nextMatchId: string | null };
export type Tournament = {
  teams: TournamentTeam[];
  matches: BracketMatch[];
  bracketSize: number;
  roundCount: number;
  excludedPlayerId: string | null;
  currentMatchId: string | null;
  championTeamId: string | null;
  autoAdvances: AutoAdvance[];
};

function shuffled<T>(items: T[], random: () => number) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function nextMatchId(tournament: Tournament, match: BracketMatch) {
  return match.round >= tournament.roundCount - 1 ? null : `r${match.round + 1}m${Math.floor(match.index / 2)}`;
}

export function resolveAutomaticAdvances(tournament: Tournament) {
  const newAdvances: AutoAdvance[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of tournament.matches) {
      if (match.resolved || match.status === "playing" || match.status === "finished") continue;
      if (match.round > 0) {
        const sourceA = tournament.matches.find((item) => item.id === match.sourceAId);
        const sourceB = tournament.matches.find((item) => item.id === match.sourceBId);
        if (!sourceA?.resolved || !sourceB?.resolved) continue;
        match.teamAId = sourceA.winnerId;
        match.teamBId = sourceB.winnerId;
      }
      if (match.teamAId && match.teamBId) {
        if (match.status !== "waiting") { match.status = "waiting"; changed = true; }
        continue;
      }
      match.resolved = true;
      match.winnerId = match.teamAId ?? match.teamBId;
      match.status = match.winnerId ? "bye" : "empty";
      if (match.winnerId) {
        newAdvances.push({ matchId: match.id, teamId: match.winnerId, nextMatchId: nextMatchId(tournament, match) });
        if (match.round === tournament.roundCount - 1) {
          tournament.championTeamId = match.winnerId;
          tournament.currentMatchId = null;
          const champion = tournament.teams.find((team) => team.id === match.winnerId);
          if (champion) champion.status = "champion";
        }
      }
      changed = true;
    }
  }
  tournament.autoAdvances.push(...newAdvances);
  return newAdvances;
}

export function selectNextMatch(tournament: Tournament) {
  const match = tournament.matches.find((item) => item.status === "waiting" && !item.resolved) ?? null;
  tournament.currentMatchId = match?.id ?? null;
  return match;
}

export function createTournament(playerIds: string[], random: () => number = Math.random): Tournament {
  if (playerIds.length < 4) throw new Error("São necessários pelo menos quatro jogadores.");
  const available = [...playerIds];
  const excludedPlayerId = available.length % 2 === 1 ? available.pop() ?? null : null;
  const pairedPlayers = shuffled(available, random);
  const rawTeams: TournamentTeam[] = [];
  for (let index = 0; index < pairedPlayers.length; index += 2) {
    rawTeams.push({ id: `team-${index / 2 + 1}`, playerIds: [pairedPlayers[index], pairedPlayers[index + 1]], status: "active", slot: -1 });
  }
  const bracketSize = 2 ** Math.ceil(Math.log2(rawTeams.length));
  const roundCount = Math.log2(bracketSize);
  const slots: Array<TournamentTeam | null> = Array(bracketSize).fill(null);
  const slotOrder = shuffled(Array.from({ length: bracketSize }, (_, index) => index), random);
  rawTeams.forEach((team, index) => { team.slot = slotOrder[index]; slots[team.slot] = team; });

  const matches: BracketMatch[] = [];
  for (let round = 0; round < roundCount; round += 1) {
    const matchesInRound = bracketSize / 2 ** (round + 1);
    for (let index = 0; index < matchesInRound; index += 1) {
      const firstRound = round === 0;
      matches.push({
        id: `r${round}m${index}`,
        round,
        index,
        sourceAId: firstRound ? null : `r${round - 1}m${index * 2}`,
        sourceBId: firstRound ? null : `r${round - 1}m${index * 2 + 1}`,
        teamAId: firstRound ? slots[index * 2]?.id ?? null : null,
        teamBId: firstRound ? slots[index * 2 + 1]?.id ?? null : null,
        winnerId: null,
        loserId: null,
        status: "pending",
        resolved: false,
      });
    }
  }
  const tournament: Tournament = { teams: rawTeams, matches, bracketSize, roundCount, excludedPlayerId, currentMatchId: null, championTeamId: null, autoAdvances: [] };
  resolveAutomaticAdvances(tournament);
  selectNextMatch(tournament);
  return tournament;
}

export function beginTournamentMatch(tournament: Tournament) {
  if (!tournament.currentMatchId) throw new Error("Não há confronto pronto para começar.");
  return beginTournamentMatchById(tournament, tournament.currentMatchId);
}

export function beginTournamentMatchById(tournament: Tournament, matchId: string) {
  const match = tournament.matches.find((item) => item.id === matchId);
  if (!match || !match.teamAId || !match.teamBId || match.resolved) throw new Error("Não há confronto pronto para começar.");
  if (match.status !== "waiting") throw new Error("Este confronto não está aguardando início.");
  match.status = "playing";
  return match;
}

export function completeTournamentMatch(tournament: Tournament, winnerId: string) {
  if (!tournament.currentMatchId) throw new Error("Não existe uma partida ativa.");
  return completeTournamentMatchById(tournament, tournament.currentMatchId, winnerId);
}

export function completeTournamentMatchById(tournament: Tournament, matchId: string, winnerId: string) {
  const match = tournament.matches.find((item) => item.id === matchId);
  if (!match || match.status !== "playing") throw new Error("Não existe uma partida ativa.");
  if (winnerId !== match.teamAId && winnerId !== match.teamBId) throw new Error("O vencedor não participa deste confronto.");
  const loserId = winnerId === match.teamAId ? match.teamBId : match.teamAId;
  match.winnerId = winnerId;
  match.loserId = loserId;
  match.status = "finished";
  match.resolved = true;
  const loser = tournament.teams.find((team) => team.id === loserId);
  if (loser) loser.status = "eliminated";
  const automatic = resolveAutomaticAdvances(tournament);
  if (match.round === tournament.roundCount - 1) {
    tournament.championTeamId = winnerId;
    const champion = tournament.teams.find((team) => team.id === winnerId);
    if (champion) champion.status = "champion";
    tournament.currentMatchId = null;
  } else {
    selectNextMatch(tournament);
  }
  return { match, winnerId, loserId, automatic, nextMatchId: tournament.currentMatchId };
}
