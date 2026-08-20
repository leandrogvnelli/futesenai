import type { Metadata } from "next";
import { FuteSenaiLobby } from "./FuteSenaiLobby";

export const metadata: Metadata = {
  title: "FuteSenai",
  description: "Futebol, conhecimento e competição em sala de aula.",
};

export default function Home() {
  return <FuteSenaiLobby />;
}
