import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ระบบขอยืมเงิน", template: "%s · ระบบขอยืมเงิน" },
  description: "ระบบขอยืมเงินและติดตามการชำระคืน",
  manifest: "/manifest.webmanifest",
  // iPhone home-screen icon (needed for Web Push on iOS) and the title shown under it
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "ขอยืมเงิน", statusBarStyle: "default" },
  // phone numbers in text must not turn into links
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#0f766e",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body className="text-slate-900 antialiased">
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
