export type QuizQuestion = { id: string; texto: string; alternativas: string[]; correta: number; explicacao: string };

export function selectQuestions<T>(questions: T[], count = 5, random = Math.random): T[] {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled.slice(0, count);
}

export function scoreAnswer(correct: boolean, elapsedMs: number, timeLimitMs = 8000) {
  if (!correct) return 0;
  const remaining = Math.max(0, Math.min(1, 1 - elapsedMs / timeLimitMs));
  return 100 + Math.round(50 * remaining);
}

export function teamQuizResult(scores: Record<string, number>, blueIds: string[], redIds: string[]) {
  const blue = blueIds.reduce((total, id) => total + (scores[id] ?? 0), 0);
  const red = redIds.reduce((total, id) => total + (scores[id] ?? 0), 0);
  return { blue, red, winner: blue === red ? null : blue > red ? "blue" as const : "red" as const };
}
