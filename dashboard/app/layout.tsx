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
