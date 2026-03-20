import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "СнабЧат — Дирекция по закупкам",
  description: "ИИ-ассистент Дирекции по закупкам с RAG-поиском по базе знаний",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
