"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { playAdvance, playCorrect, playMenu, playWrong } from "./gameAudio";
import { SoundToggle } from "./SoundToggle";

type Player = { id: string; nickname: string };
export type PublicQuiz = {
  index: number; total: number; stage: "answering" | "feedback" | "result";
  question: { id: string; texto: string; alternativas: string[]; correta?: number; explicacao?: string } | null;
  answeredIds: string[]; scores?: Record<string, number>; blueScore: number; redScore: number;
  winner: "blue" | "red" | null; timeLimitMs: number; questionStartedAt: number; activeIds: string[];
  mode: "halftime" | "golden"; attempt: number; winnerPlayerId: string | null;
};

export function QuizOverlay({ phase, quiz, playerId, players, onAnswer }: { phase: "quiz" | "quizResult" | "goldenQuestion" | "goldenResult"; quiz: PublicQuiz | null; playerId: string; players: Player[]; onAnswer: (choice: number) => void }) {
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [now, setNow] = useState(0);
  const lastSoundKey = useRef("");
  const questionId = quiz?.question?.id ?? "";
  const selectionKey = `${quiz?.mode ?? "quiz"}-${quiz?.attempt ?? quiz?.index ?? 0}-${questionId}`;
  const selected = selections[selectionKey] ?? null;
  const active = Boolean(quiz?.activeIds.includes(playerId));
  const answered = Boolean(quiz?.answeredIds.includes(playerId));
  useEffect(() => {
    if (!["quiz", "goldenQuestion"].includes(phase) || quiz?.stage !== "answering") return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 100);
    return () => clearInterval(timer);
  }, [phase, quiz?.stage, quiz?.index]);

  useEffect(() => {
    if (!quiz) return;
    const key = `${quiz.mode}-${quiz.attempt}-${quiz.index}-${quiz.stage}-${quiz.winnerPlayerId ?? "none"}`;
    if (lastSoundKey.current === key) return;
    lastSoundKey.current = key;
    if (quiz.stage === "result") playAdvance();
    if (quiz.stage !== "feedback") return;
    if (quiz.mode === "golden") { if (quiz.winnerPlayerId) playAdvance(); else playWrong(); return; }
    if (selected !== null) { if (quiz.question?.correta === selected) playCorrect(); else playWrong(); }
  }, [quiz, selected]);

  const answer = (choice: number) => {
    if (!active || answered || quiz?.stage !== "answering") return;
    playMenu(); setSelections((current) => ({ ...current, [selectionKey]: choice })); onAnswer(choice);
  };
  const remaining = quiz ? Math.max(0, quiz.timeLimitMs - (now ? now - quiz.questionStartedAt : 0)) : 0;

  return <main className="classic-page quiz-page">
    <header className="classic-nav"><Image src="/senai-logo.png" alt="SENAI" width={439} height={88} /><strong>FuteSenai</strong><span>{quiz?.mode === "golden" ? "Desempate" : "Intervalo educativo"}</span><SoundToggle /></header>
    <section className="classic-modal quiz-modal">
      {quiz?.stage === "result" || phase === "quizResult" ? <>
        <h1>Resultado do intervalo</h1>
        <div className="quiz-score"><div className="blue"><span>Dupla azul</span><strong>{quiz?.blueScore ?? 0}</strong></div><b>×</b><div className="red"><span>Dupla vermelha</span><strong>{quiz?.redScore ?? 0}</strong></div></div>
        <div className="bonus-box">{quiz?.winner ? <><strong>Bônus: dupla {quiz.winner === "blue" ? "azul" : "vermelha"}</strong><span>+12% aceleração · +8% velocidade · +15% chute</span></> : <><strong>Empate nas perguntas</strong><span>Nenhuma dupla recebe bônus.</span></>}</div>
        <p>O segundo tempo começa em instantes.</p>
      </> : quiz?.question ? <>
        <div className={`quiz-title ${quiz.mode === "golden" ? "golden" : ""}`}><h1>{quiz.mode === "golden" ? `★ Pergunta de ouro · Tentativa ${quiz.attempt}` : `Intervalo · Pergunta ${quiz.index + 1}/${quiz.total}`}</h1><strong>{quiz.stage === "answering" ? `${Math.ceil(remaining / 1000)}s` : ""}</strong></div>
        {quiz.mode === "golden" && quiz.stage === "answering" && <p className="golden-rule">O primeiro jogador que acertar classifica sua dupla.</p>}
        <p className="quiz-question">{quiz.question.texto}</p>
        <div className="quiz-options">{quiz.question.alternativas.map((option, index) => {
          const correct = quiz.stage === "feedback" && quiz.question?.correta === index;
          const wrong = quiz.stage === "feedback" && selected === index && !correct;
          return <button key={option} type="button" className={`${selected === index ? "selected" : ""} ${correct ? "correct" : ""} ${wrong ? "wrong" : ""}`} disabled={!active || answered || quiz.stage !== "answering"} onClick={() => answer(index)}><kbd>{index + 1}</kbd><span>{option}</span></button>;
        })}</div>
        {quiz.stage === "feedback" ? <div className={`quiz-feedback ${quiz.mode === "golden" ? "golden-feedback" : ""}`}>
          {quiz.mode === "golden" ? quiz.winnerPlayerId ? <><strong>{players.find((player) => player.id === quiz.winnerPlayerId)?.nickname ?? "Jogador"} acertou primeiro!</strong><span>A dupla {quiz.winner === "blue" ? "azul" : "vermelha"} venceu a partida.</span></> : <><strong>Ninguém acertou</strong><span>Uma nova pergunta de ouro será exibida em instantes.</span></> : <><strong>Resposta correta</strong><span>{quiz.question.explicacao}</span></>}
        </div> : <p className="quiz-status">{!active ? "Você está assistindo. Apenas os quatro jogadores respondem." : answered ? "Resposta registrada. Aguarde os outros jogadores." : "Responda sozinho — ninguém vê sua alternativa."}</p>}
        <div className="answer-roster">{quiz.activeIds.map((id) => <span className={quiz.answeredIds.includes(id) ? "done" : ""} key={id}>{players.find((player) => player.id === id)?.nickname ?? "Jogador"} {quiz.answeredIds.includes(id) ? "✓" : "…"}</span>)}</div>
      </> : <p>Carregando perguntas...</p>}
    </section>
  </main>;
}
