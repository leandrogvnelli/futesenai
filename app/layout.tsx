import type { Metadata } from "next";
import "./globals.css";
import "./haxball-senai.css";

export const metadata: Metadata = {
  title: "FuteSenai",
  description: "Protótipo educacional multiplayer do SENAI.",
  icons: {
    icon: "/senai-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="theme-haxball-senai">{children}</body>
    </html>
  );
}
