import type { Metadata } from "next";
import { TrainingArena } from "./TrainingArena";

export const metadata: Metadata = {
  title: "Campo de treino · FuteSenai",
  description: "Teste de movimentação e física do FuteSenai.",
};

export default function TrainingPage() {
  return <TrainingArena />;
}
