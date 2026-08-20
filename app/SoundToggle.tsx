"use client";

import { useState } from "react";
import { isSoundEnabled, setSoundEnabled } from "./gameAudio";

export function SoundToggle() {
  const [enabled, setEnabled] = useState(isSoundEnabled);
  const toggle = () => { const next = !enabled; setEnabled(next); setSoundEnabled(next); };
  return <button className="sound-toggle" type="button" onClick={toggle} aria-label={enabled ? "Desativar sons" : "Ativar sons"} title={enabled ? "Desativar sons" : "Ativar sons"}>{enabled ? "🔊" : "🔇"}<span>{enabled ? "Som" : "Mudo"}</span></button>;
}
