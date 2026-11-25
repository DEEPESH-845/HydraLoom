import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "GANTRYLAB - Underwater Robotics Testbed",
  applicationName: "GANTRYLAB",
  openGraph: { type: "website", title: "GANTRYLAB", description: "Test underwater robots and their vision models: six field environments, a gantry testbed, model benchmarking and learned autonomy." },
  description:
    "A controlled aquarium and XY gantry for testing underwater perception, navigation and autonomy before field deployment. Interactive simulation of the physical prototype.",
};

export const viewport: Viewport = { themeColor: "#0b1219" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
