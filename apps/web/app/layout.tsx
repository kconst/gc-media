import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Grand Canyon Trip Map",
  description: "Geotagged photos and videos from our Grand Canyon trip.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
