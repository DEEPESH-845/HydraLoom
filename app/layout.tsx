import type { Metadata } from "next";
import { Inter, Orbitron } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const orbitron = Orbitron({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HYDRALOOM Mission Control",
  description: "Cinematic underwater ROV telemetry dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${orbitron.variable} antialiased bg-tactical-bg text-tactical-text`}
      >
        <div className="fixed inset-0 crt-overlay z-50 pointer-events-none opacity-20"></div>
        {children}
      </body>
    </html>
  );
}
