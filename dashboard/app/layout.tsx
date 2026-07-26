import "./globals.css";

export const metadata = {
  title: "Kalshi BTC Prediction Dashboard",
  viewport: "width=device-width, initial-scale=1",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0b1020", color: "#e8ecf1" }}>
        {children}
      </body>
    </html>
  );
}
