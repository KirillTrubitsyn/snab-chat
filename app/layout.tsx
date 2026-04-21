import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "СнабЧат — Дирекция по закупкам",
  description: "ИИ-ассистент Дирекции по закупкам с RAG-поиском по базе знаний",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "СнабЧат",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1976D2",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("x-nonce") || "";

  return (
    <html lang="ru">
      <body>
        {/* Отмечаем <html class="icons-ready"> как только загружен Material
            Symbols. До этого момента страховочное `visibility: hidden` в
            globals.css скрывает сырые лигатуры ("monitoring", "chat"…), чтобы
            они не мигали текстом при медленной загрузке иконочного шрифта.
            Таймаут 3 с гарантирует, что иконки не останутся скрыты, если CDN
            шрифтов недоступен. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){var h=document.documentElement;var r=function(){h.classList.add('icons-ready')};if(document.fonts&&document.fonts.load){document.fonts.load('24px "Material Symbols Outlined"').then(r,r);if(document.fonts.ready&&document.fonts.ready.then){document.fonts.ready.then(r)}}else{r()}setTimeout(r,3000)})();`,
          }}
        />
        {children}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js');
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
