import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EMRN Pulse | AI Medical Supply Assistant",
  description: "EMRN Pulse helps customers find medical supplies, request quotes, and connect with EMRN support.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
