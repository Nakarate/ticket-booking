import "./globals.css";

export const metadata = { title: "Live in Bangkok 2026 — จองตั๋ว" };
export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0c1013",
};

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Kanit (display) + IBM Plex Sans Thai (body). Degrades to a Thai-capable
            system stack (see --display/--body in globals.css) if offline. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
