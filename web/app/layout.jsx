export const metadata = { title: "Live in Bangkok 2026 — Booking" };

export default function RootLayout({ children }) {
  return (
    <html lang="th">
      <body
        style={{
          margin: 0,
          background: "#101418",
          color: "#e8e6df",
          fontFamily:
            "'Helvetica Neue', 'Segoe UI', system-ui, sans-serif",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
