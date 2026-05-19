import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "Blue Collar Coach Connect",
    template: "%s · BCC Connect",
  },
  description:
    "The operations platform for blue-collar businesses. CRM, calendars, time tracking, financial KPIs, and coaching — built for the trades.",
  applicationName: "Blue Collar Coach Connect",
  authors: [{ name: "Blue Collar Coach" }],
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  ),
};

export const viewport = {
  themeColor: "#1a1a1a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
} as const;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
